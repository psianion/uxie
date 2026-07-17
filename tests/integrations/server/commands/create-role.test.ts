import { describe, expect, test, mock } from "bun:test";
import { Collection, PermissionFlagsBits } from "discord.js";
import { buildCreateRoleCommand } from "../../../../src/integrations/server/commands/create-role.ts";
import { handleInteraction } from "../../../../src/bot/interaction-router.ts";
import { ConfigError } from "../../../../src/lib/errors.ts";

const ctx = { clientTag: "uxie-x", log: { info() {}, warn() {}, error() {} } as any };

const ROLE_ID = "555555555555555555";

const V2 = 1 << 15; // MessageFlags.IsComponentsV2 = 32768

// Inline ChatInputCommandInteraction mock for /create-role. The command opts INTO the router's
// auto-defer (it does NOT set defer:false), so the router acknowledges first and execute renders
// via i.editReply on the deferred reply. The factory is router-ready: deferReply flips `deferred`
// like the real client, so it can be driven directly (unit) OR through handleInteraction.
function roleInteraction(opts: {
  name?: string;
  color?: string | null;
  color_hex?: string | null;
  hoist?: boolean | null;
  mentionable?: boolean | null;
  position?: number | null;
  permission_preset?: string | null;
  perms?: Record<string, boolean | null>; // keyed by perm_* option name
  reason?: string | null;
} = {}): any {
  const created = {
    id: ROLE_ID,
    name: opts.name ?? "new-role",
    position: opts.position ?? 1,
  };
  const rolesCreate = mock(async (_: unknown) => created);
  const perms = opts.perms ?? {};
  return {
    id: "iid-role-1",
    commandName: "create-role",
    user: { id: "123" },
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    isButton: () => false,
    isMessageContextMenuCommand: () => false,
    deferReply: mock(async function (this: any) {
      this.deferred = true;
    }),
    client: { user: { id: "999999999999999999" } },
    guild: {
      name: "My Guild",
      roles: { create: rolesCreate },
    },
    options: {
      getString: mock((n: string, _req?: boolean) => {
        if (n === "name") return opts.name ?? "new-role";
        if (n === "color") return opts.color ?? null;
        if (n === "color_hex") return opts.color_hex ?? null;
        if (n === "permission_preset") return opts.permission_preset ?? null;
        if (n === "reason") return opts.reason ?? null;
        return null;
      }),
      getInteger: mock((n: string) => (n === "position" ? opts.position ?? null : null)),
      getBoolean: mock((n: string) => {
        if (n === "hoist") return opts.hoist ?? null;
        if (n === "mentionable") return opts.mentionable ?? null;
        if (n in perms) return perms[n] ?? null;
        return null;
      }),
    },
    editReply: mock(async (_: unknown) => {}),
    reply: mock(async (_: unknown) => {}),
    __rolesCreate: rolesCreate,
    __created: created,
  };
}

describe("/create-role builder", () => {
  test("opts INTO the router's auto-defer so the ack precedes the roles.create write", () => {
    // defer:false would make the ONLY ack i.reply AFTER guild.roles.create — any latency in that
    // network write blows Discord's 3s window and surfaces as "application did not respond".
    // The router must defer first (instant ack, no I/O); execute renders via editReply.
    expect(buildCreateRoleCommand().defer).not.toBe(false);
  });

  test("command data name is 'create-role' with default builder shape (decision 7)", () => {
    const cmd = buildCreateRoleCommand();
    expect(cmd.data.name).toBe("create-role");
    expect((cmd.data as any).toJSON().default_member_permissions).toBe("0");
    expect((cmd.data as any).toJSON().contexts).toContain(0);
    expect((cmd.data as any).toJSON().integration_types).toContain(0);
  });

  test("name option is String, required", () => {
    const json = (buildCreateRoleCommand().data as any).toJSON();
    const name = json.options.find((o: any) => o.name === "name");
    expect(name).toBeDefined();
    expect(name.type).toBe(3); // String
    expect(name.required).toBe(true);
  });

  test("color option has named-color choices (>= 12)", () => {
    const json = (buildCreateRoleCommand().data as any).toJSON();
    const color = json.options.find((o: any) => o.name === "color");
    expect(color).toBeDefined();
    expect(color.type).toBe(3); // String
    expect(color.required ?? false).toBe(false);
    expect(Array.isArray(color.choices)).toBe(true);
    expect(color.choices.length).toBeGreaterThanOrEqual(12);
  });

  test("color_hex, reason are optional String options", () => {
    const json = (buildCreateRoleCommand().data as any).toJSON();
    const byName: Record<string, any> = Object.fromEntries(
      json.options.map((o: any) => [o.name, o]),
    );
    for (const opt of ["color_hex", "reason"]) {
      expect(byName[opt]).toBeDefined();
      expect(byName[opt].type).toBe(3); // String
      expect(byName[opt].required ?? false).toBe(false);
    }
  });

  test("permission_preset option carries the five preset choices", () => {
    const json = (buildCreateRoleCommand().data as any).toJSON();
    const preset = json.options.find((o: any) => o.name === "permission_preset");
    expect(preset).toBeDefined();
    const values = preset.choices.map((c: any) => c.value).sort();
    expect(values).toEqual(["admin", "manager", "member", "moderator", "none"]);
  });

  test("hoist/mentionable and a couple perm_* booleans present and not required", () => {
    const json = (buildCreateRoleCommand().data as any).toJSON();
    const byName: Record<string, any> = Object.fromEntries(
      json.options.map((o: any) => [o.name, o]),
    );
    for (const opt of [
      "hoist",
      "mentionable",
      "perm_administrator",
      "perm_manage_roles",
      "perm_ban_members",
    ]) {
      expect(byName[opt]).toBeDefined();
      expect(byName[opt].type).toBe(5); // Boolean
      expect(byName[opt].required ?? false).toBe(false);
    }
  });

  test("position option is Integer with min_value 1", () => {
    const json = (buildCreateRoleCommand().data as any).toJSON();
    const position = json.options.find((o: any) => o.name === "position");
    expect(position.type).toBe(4); // Integer
    expect(position.min_value).toBe(1);
  });

  test("option count is within Discord's 25 cap", () => {
    const json = (buildCreateRoleCommand().data as any).toJSON();
    expect(json.options.length).toBeLessThanOrEqual(25);
  });
});

describe("/create-role execute", () => {
  test("creates role with name + preset permissions OR toggled perm_*; renders V2 panel via editReply", async () => {
    const cmd = buildCreateRoleCommand();
    const i = roleInteraction({
      name: "Mods",
      permission_preset: "moderator",
      perms: { perm_ban_members: true },
    });
    await cmd.execute(i, ctx);

    expect(i.__rolesCreate).toHaveBeenCalledTimes(1);
    const arg = i.__rolesCreate.mock.calls[0][0];
    expect(arg.name).toBe("Mods");

    // moderator preset includes KickMembers + ManageMessages; toggle adds BanMembers.
    const bits = BigInt(arg.permissions);
    expect((bits & PermissionFlagsBits.KickMembers) !== 0n).toBe(true);
    expect((bits & PermissionFlagsBits.ManageMessages) !== 0n).toBe(true);
    expect((bits & PermissionFlagsBits.BanMembers) !== 0n).toBe(true);

    // V2 result rendered via editReply on the deferred reply — NOT a fresh i.reply (which would
    // tie the only ack to AFTER the network write). Ephemerality comes from the router's defer.
    expect(i.reply).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledTimes(1);
    const payload = i.editReply.mock.calls[0][0];
    expect(payload.flags & V2).toBe(V2);
    expect(Array.isArray(payload.components)).toBe(true);
    expect(payload.components.length).toBeGreaterThan(0);
    expect(payload.content).toBeUndefined();
    expect(payload.embeds).toBeUndefined();

    // Inspect the rendered container so a wrong-but-non-empty panel can't pass.
    const json = JSON.stringify(payload.components[0].toJSON());
    expect(json).toContain(`<@&${ROLE_ID}>`); // role badge/name mention
    expect(json).toContain("Role created"); // StatusModel.title
    expect(json).toContain("moderator"); // preset label in Permissions row
    expect(json).toContain("granted"); // `${preset} · N granted`
  });

  test("no preset/perms renders a 'none' Permissions row", async () => {
    const cmd = buildCreateRoleCommand();
    const i = roleInteraction({ name: "Plain" });
    await cmd.execute(i, ctx);
    const payload = i.editReply.mock.calls[0][0];
    const json = JSON.stringify(payload.components[0].toJSON());
    expect(json).toContain(`<@&${ROLE_ID}>`);
    expect(json).toContain("none");
    expect(json).not.toContain("granted");
  });

  test("no preset and no perm toggles: permissions key omitted from create call", async () => {
    const cmd = buildCreateRoleCommand();
    const i = roleInteraction({ name: "Plain" });
    await cmd.execute(i, ctx);
    const arg = i.__rolesCreate.mock.calls[0][0];
    expect("permissions" in arg).toBe(false);
  });

  test("admin preset yields Administrator bit", async () => {
    const cmd = buildCreateRoleCommand();
    const i = roleInteraction({ name: "Boss", permission_preset: "admin" });
    await cmd.execute(i, ctx);
    const bits = BigInt(i.__rolesCreate.mock.calls[0][0].permissions);
    expect((bits & PermissionFlagsBits.Administrator) !== 0n).toBe(true);
  });

  test("color_hex overrides named color choice", async () => {
    const cmd = buildCreateRoleCommand();
    const i = roleInteraction({ name: "C", color: "Red", color_hex: "#5865F2" });
    await cmd.execute(i, ctx);
    expect(i.__rolesCreate.mock.calls[0][0].color).toBe(0x5865f2);
  });

  test("named color choice maps to its exact hex value (Red → 0xed4245) when no color_hex", async () => {
    const cmd = buildCreateRoleCommand();
    const i = roleInteraction({ name: "C", color: "Red" });
    await cmd.execute(i, ctx);
    expect(i.__rolesCreate.mock.calls[0][0].color).toBe(0xed4245);
  });

  test('"Default" color choice omits color (true no-color, not #000000)', async () => {
    const cmd = buildCreateRoleCommand();
    const i = roleInteraction({ name: "C", color: "Default" });
    await cmd.execute(i, ctx);
    expect("color" in i.__rolesCreate.mock.calls[0][0]).toBe(false);
    const json = JSON.stringify(i.editReply.mock.calls[0][0].components[0].toJSON());
    expect(json).toContain("default");
  });

  test("hoist/mentionable/position/reason forwarded when provided", async () => {
    const cmd = buildCreateRoleCommand();
    const i = roleInteraction({
      name: "Sep",
      hoist: true,
      mentionable: true,
      position: 3,
      reason: "audit me",
    });
    await cmd.execute(i, ctx);
    const arg = i.__rolesCreate.mock.calls[0][0];
    expect(arg.hoist).toBe(true);
    expect(arg.mentionable).toBe(true);
    expect(arg.position).toBe(3);
    expect(arg.reason).toBe("audit me");
  });

  test("invalid color_hex throws ConfigError", async () => {
    const cmd = buildCreateRoleCommand();
    const i = roleInteraction({ name: "C", color_hex: "nothex" });
    let caught: unknown;
    try {
      await cmd.execute(i, ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).code).toBe("create-role");
    expect(i.__rolesCreate).not.toHaveBeenCalled();
  });

  test("missing guild throws ConfigError", async () => {
    const cmd = buildCreateRoleCommand();
    const i = roleInteraction({ name: "C" });
    i.guild = null;
    let caught: unknown;
    try {
      await cmd.execute(i, ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).code).toBe("create-role");
  });
});

// Regression guard for the "application did not respond" class: a command must acknowledge the
// interaction (defer/reply) BEFORE it performs an unbounded network write. The earlier unit tests
// called execute() directly with a never-failing reply mock, so they could not catch a command
// that did guild.roles.create() before its only ack. These drive the REAL interaction-router.
describe("/create-role through the real interaction-router (ack-before-I/O)", () => {
  function routed() {
    const commands = new Collection<string, any>();
    commands.set("create-role", buildCreateRoleCommand());
    return commands;
  }

  test("defers (acknowledges within the 3s window) BEFORE the roles.create network write", async () => {
    const commands = routed();
    const i = roleInteraction({ name: "Mods", permission_preset: "moderator" });

    // Record the ack state at the moment the write ran (array index avoids TS null-narrowing
    // of a closure var the type-checker can't prove the mock callback assigned).
    const ackedWhenWriteRan: boolean[] = [];
    const created = i.__created;
    i.guild.roles.create = mock(async (_: unknown) => {
      ackedWhenWriteRan.push(i.deferred === true);
      return created;
    });

    await handleInteraction(i, commands, "123");

    expect(i.deferReply).toHaveBeenCalledTimes(1); // router acked first, no I/O before it
    expect(ackedWhenWriteRan[0]).toBe(true); // the ack PRECEDED the network write
    expect(i.editReply).toHaveBeenCalledTimes(1); // V2 result rendered on the deferred reply
    expect(i.reply).not.toHaveBeenCalled(); // never the fragile reply-after-write path
  });

  test("a slow/failing roles.create still leaves the user acknowledged (no silent timeout)", async () => {
    const commands = routed();
    const i = roleInteraction({ name: "Mods" });
    i.guild.roles.create = mock(async () => {
      throw new Error("discord 50013 missing permissions");
    });

    await handleInteraction(i, commands, "123");

    // Because the router deferred up-front, the write throwing surfaces as an error editReply —
    // the user sees feedback, never Discord's "application did not respond".
    expect(i.deferReply).toHaveBeenCalledTimes(1);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining("uxie crashed"));
  });
});
