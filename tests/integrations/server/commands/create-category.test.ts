import { describe, expect, test, mock } from "bun:test";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { buildCreateCategoryCommand } from "../../../../src/integrations/server/commands/create-category.ts";
import { buildPrivateOverwrites } from "../../../../src/integrations/server/permissions.ts";

const ctx = { clientTag: "uxie-x", log: { info() {}, warn() {}, error() {} } as any };

const EVERYONE_ID = "111111111111111111";
const BOT_ID = "999999999999999999";
const ROLE_A = "333333333333333333";
const ROLE_B = "444444444444444444";

// Inline ChatInputCommandInteraction mock. The router already deferReply'd, so the command
// replies via editReply. options.* returns whatever each option override supplies.
function catInteraction(opts: {
  name?: string;
  position?: number | null;
  private?: boolean | null;
  guild?: unknown;
  accessRoles?: Record<string, { id: string } | null>; // keyed by option name
} = {}): any {
  const created = { name: opts.name ?? "general" };
  const channelsCreate = mock(async (_: unknown) => created);
  const accessRoles = opts.accessRoles ?? {};
  const guild =
    opts.guild ??
    ({
      roles: { everyone: { id: EVERYONE_ID } },
      channels: { create: channelsCreate },
    } as any);
  return {
    deferred: true,
    client: { user: { id: BOT_ID } },
    guild,
    options: {
      getString: mock((n: string, _req?: boolean) => (n === "name" ? opts.name ?? "general" : null)),
      getInteger: mock((n: string) => (n === "position" ? opts.position ?? null : null)),
      getBoolean: mock((n: string) => (n === "private" ? opts.private ?? null : null)),
      getRole: mock((n: string) => accessRoles[n] ?? null),
    },
    editReply: mock(async (_: unknown) => {}),
    __channelsCreate: channelsCreate,
  };
}

describe("/create-category builder", () => {
  test("command data name is 'create-category'", () => {
    expect(buildCreateCategoryCommand().data.name).toBe("create-category");
  });

  test("toJSON option shape: name (required string), position (int), private (bool)", () => {
    const json = (buildCreateCategoryCommand().data as any).toJSON();
    const byName: Record<string, any> = Object.fromEntries(
      json.options.map((o: any) => [o.name, o]),
    );
    expect(byName.name.type).toBe(3); // ApplicationCommandOptionType.String
    expect(byName.name.required).toBe(true);
    expect(byName.position.type).toBe(4); // Integer
    expect(byName.position.required ?? false).toBe(false);
    expect(byName.private.type).toBe(5); // Boolean
    expect(byName.private.required ?? false).toBe(false);
  });

  test("optional access_role/_2/_3 are Role options (type 8) and not required", () => {
    const json = (buildCreateCategoryCommand().data as any).toJSON();
    const byName: Record<string, any> = Object.fromEntries(
      json.options.map((o: any) => [o.name, o]),
    );
    for (const opt of ["access_role", "access_role_2", "access_role_3"]) {
      expect(byName[opt]).toBeDefined();
      expect(byName[opt].type).toBe(8); // Role
      expect(byName[opt].required ?? false).toBe(false);
    }
  });

  test("withOwnerGate setters present (default_member_permissions, guild context, GuildInstall)", () => {
    const json = (buildCreateCategoryCommand().data as any).toJSON();
    expect(json.default_member_permissions).toBe("0");
    expect(json.contexts).toContain(0); // InteractionContextType.Guild
    expect(json.integration_types).toContain(0); // ApplicationIntegrationType.GuildInstall
  });
});

describe("/create-category execute", () => {
  test("non-private: channels.create called as GuildCategory with NO permissionOverwrites", async () => {
    const cmd = buildCreateCategoryCommand();
    const i = catInteraction({ name: "lounge" });
    await cmd.execute(i, ctx);
    expect(i.__channelsCreate).toHaveBeenCalledTimes(1);
    const arg = i.__channelsCreate.mock.calls[0][0];
    expect(arg.type).toBe(ChannelType.GuildCategory);
    expect(arg.name).toBe("lounge");
    expect("permissionOverwrites" in arg).toBe(false);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining("lounge"));
  });

  test("private:true with access roles: overwrites match buildPrivateOverwrites(roles, everyone, bot)", async () => {
    const cmd = buildCreateCategoryCommand();
    const i = catInteraction({
      name: "secret",
      private: true,
      accessRoles: { access_role: { id: ROLE_A }, access_role_2: { id: ROLE_B } },
    });
    await cmd.execute(i, ctx);
    const arg = i.__channelsCreate.mock.calls[0][0];
    const expected = buildPrivateOverwrites([ROLE_A, ROLE_B], EVERYONE_ID, BOT_ID);
    expect(arg.permissionOverwrites).toEqual(expected);
    // first element denies ViewChannel for everyone.id
    expect(arg.permissionOverwrites[0].id).toBe(EVERYONE_ID);
    expect(arg.permissionOverwrites[0].deny).toContain(PermissionFlagsBits.ViewChannel);
    // bot allow last
    const last = arg.permissionOverwrites[arg.permissionOverwrites.length - 1];
    expect(last.id).toBe(BOT_ID);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining("(private)"));
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining(`<@&${ROLE_A}>`));
  });

  test("private:true with NO access roles: deny everyone + allow bot only; reply says admins-only", async () => {
    const cmd = buildCreateCategoryCommand();
    const i = catInteraction({ name: "secret", private: true });
    await cmd.execute(i, ctx);
    const ow = i.__channelsCreate.mock.calls[0][0].permissionOverwrites;
    expect(ow.map((o: any) => o.id)).toEqual([EVERYONE_ID, BOT_ID]);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining("admins"));
  });

  test("position passed through when provided", async () => {
    const cmd = buildCreateCategoryCommand();
    const i = catInteraction({ name: "ordered", position: 3 });
    await cmd.execute(i, ctx);
    expect(i.__channelsCreate.mock.calls[0][0].position).toBe(3);
  });

  test("position omitted when null", async () => {
    const cmd = buildCreateCategoryCommand();
    const i = catInteraction({ name: "unordered", position: null });
    await cmd.execute(i, ctx);
    expect("position" in i.__channelsCreate.mock.calls[0][0]).toBe(false);
  });

  test("throws ConfigError when no guild context", async () => {
    const cmd = buildCreateCategoryCommand();
    const i = catInteraction({ name: "x" });
    i.guild = null;
    await expect(cmd.execute(i, ctx)).rejects.toThrow(/no guild context/);
  });
});
