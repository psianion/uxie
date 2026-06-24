import { describe, expect, test, mock } from "bun:test";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { buildCreateChannelCommand } from "../../../../src/integrations/server/commands/create-channel.ts";

const ctx = { clientTag: "uxie-x", log: { info() {}, warn() {}, error() {} } as any };

const EVERYONE_ID = "111111111111111111";
const CATEGORY_ID = "222222222222222222";
const BOT_ID = "999999999999999999";
const ROLE_A = "333333333333333333";
const ROLE_B = "444444444444444444";

// Inline ChatInputCommandInteraction mock for /create-channel. The router already deferReply'd.
function chanInteraction(opts: {
  name?: string;
  type?: string;
  topic?: string | null;
  slowmode?: number | null;
  private?: boolean | null;
  nsfw?: boolean | null;
  accessRoles?: Record<string, { id: string } | null>; // keyed by option name
} = {}): any {
  const created = { name: opts.name ?? "general" };
  const channelsCreate = mock(async (_: unknown) => created);
  const category = { id: CATEGORY_ID, name: "My Category" };
  const accessRoles = opts.accessRoles ?? {};
  return {
    deferred: true,
    client: { user: { id: BOT_ID } },
    guild: {
      roles: { everyone: { id: EVERYONE_ID } },
      channels: { create: channelsCreate },
    },
    options: {
      getString: mock((n: string, _req?: boolean) => {
        if (n === "name") return opts.name ?? "general";
        if (n === "type") return opts.type ?? "text";
        if (n === "topic") return opts.topic ?? null;
        return null;
      }),
      getChannel: mock((_n: string, _req?: boolean) => category),
      getInteger: mock((n: string) => (n === "slowmode" ? opts.slowmode ?? null : null)),
      getBoolean: mock((n: string) => {
        if (n === "private") return opts.private ?? null;
        if (n === "nsfw") return opts.nsfw ?? null;
        return null;
      }),
      getRole: mock((n: string) => accessRoles[n] ?? null),
    },
    editReply: mock(async (_: unknown) => {}),
    __channelsCreate: channelsCreate,
    __category: category,
  };
}

describe("/create-channel builder", () => {
  test("command data name is 'create-channel'", () => {
    expect(buildCreateChannelCommand().data.name).toBe("create-channel");
  });

  test("category option restricts channel_types to GuildCategory", () => {
    const json = (buildCreateChannelCommand().data as any).toJSON();
    const category = json.options.find((o: any) => o.name === "category");
    expect(category.required).toBe(true);
    expect(category.channel_types).toContain(ChannelType.GuildCategory);
  });

  test("type option carries the four string choices text|voice|forum|announcement", () => {
    const json = (buildCreateChannelCommand().data as any).toJSON();
    const type = json.options.find((o: any) => o.name === "type");
    expect(type.required).toBe(true);
    const values = type.choices.map((c: any) => c.value).sort();
    expect(values).toEqual(["announcement", "forum", "text", "voice"]);
  });

  test("optional topic/slowmode/private/nsfw present and not required", () => {
    const json = (buildCreateChannelCommand().data as any).toJSON();
    const byName: Record<string, any> = Object.fromEntries(
      json.options.map((o: any) => [o.name, o]),
    );
    for (const opt of ["topic", "slowmode", "private", "nsfw"]) {
      expect(byName[opt]).toBeDefined();
      expect(byName[opt].required ?? false).toBe(false);
    }
    expect(byName.topic.type).toBe(3); // String
    expect(byName.slowmode.type).toBe(4); // Integer
    expect(byName.private.type).toBe(5); // Boolean
    expect(byName.nsfw.type).toBe(5); // Boolean
  });

  test("optional access_role/_2/_3 are Role options (type 8) and not required", () => {
    const json = (buildCreateChannelCommand().data as any).toJSON();
    const byName: Record<string, any> = Object.fromEntries(
      json.options.map((o: any) => [o.name, o]),
    );
    for (const opt of ["access_role", "access_role_2", "access_role_3"]) {
      expect(byName[opt]).toBeDefined();
      expect(byName[opt].type).toBe(8); // Role
      expect(byName[opt].required ?? false).toBe(false);
    }
  });

  test("withOwnerGate setters present", () => {
    const json = (buildCreateChannelCommand().data as any).toJSON();
    expect(json.default_member_permissions).toBe("0");
    expect(json.contexts).toContain(0);
    expect(json.integration_types).toContain(0);
  });
});

describe("/create-channel execute", () => {
  test("text type: create called with parent=category.id, GuildText, topic+rateLimit included", async () => {
    const cmd = buildCreateChannelCommand();
    const i = chanInteraction({ name: "chat", type: "text", topic: "hello", slowmode: 10 });
    await cmd.execute(i, ctx);
    const arg = i.__channelsCreate.mock.calls[0][0];
    expect(arg.parent).toBe(CATEGORY_ID);
    expect(arg.type).toBe(ChannelType.GuildText);
    expect(arg.name).toBe("chat");
    expect(arg.topic).toBe("hello");
    expect(arg.rateLimitPerUser).toBe(10);
    expect(i.editReply).toHaveBeenCalledWith(
      expect.stringContaining("My Category"),
    );
  });

  test("voice type: topic and rateLimitPerUser OMITTED even when provided", async () => {
    const cmd = buildCreateChannelCommand();
    const i = chanInteraction({ name: "voicechan", type: "voice", topic: "ignored", slowmode: 30 });
    await cmd.execute(i, ctx);
    const arg = i.__channelsCreate.mock.calls[0][0];
    expect(arg.type).toBe(ChannelType.GuildVoice);
    expect("topic" in arg).toBe(false);
    expect("rateLimitPerUser" in arg).toBe(false);
  });

  test("forum type maps to GuildForum", async () => {
    const cmd = buildCreateChannelCommand();
    const i = chanInteraction({ name: "forum", type: "forum" });
    await cmd.execute(i, ctx);
    expect(i.__channelsCreate.mock.calls[0][0].type).toBe(ChannelType.GuildForum);
  });

  test("announcement type maps to GuildAnnouncement", async () => {
    const cmd = buildCreateChannelCommand();
    const i = chanInteraction({ name: "news", type: "announcement" });
    await cmd.execute(i, ctx);
    expect(i.__channelsCreate.mock.calls[0][0].type).toBe(ChannelType.GuildAnnouncement);
  });

  test("private:true with access roles: overwrites deny everyone, allow each role, allow bot last", async () => {
    const cmd = buildCreateChannelCommand();
    const i = chanInteraction({
      name: "secret",
      type: "text",
      private: true,
      accessRoles: { access_role: { id: ROLE_A }, access_role_2: { id: ROLE_B } },
    });
    await cmd.execute(i, ctx);
    const arg = i.__channelsCreate.mock.calls[0][0];
    const ow = arg.permissionOverwrites;
    expect(Array.isArray(ow)).toBe(true);
    // [everyone deny, ROLE_A allow, ROLE_B allow, BOT allow]
    expect(ow.map((o: any) => o.id)).toEqual([EVERYONE_ID, ROLE_A, ROLE_B, BOT_ID]);
    expect(ow[0].deny).toContain(PermissionFlagsBits.ViewChannel);
    expect(ow[1].allow).toContain(PermissionFlagsBits.ViewChannel);
    expect(ow[3].allow).toContain(PermissionFlagsBits.ViewChannel);
    // reply names the granted roles
    expect(i.editReply).toHaveBeenCalledWith(
      expect.stringContaining(`<@&${ROLE_A}>`),
    );
  });

  test("private:true dedupes a role picked twice", async () => {
    const cmd = buildCreateChannelCommand();
    const i = chanInteraction({
      name: "secret",
      type: "text",
      private: true,
      accessRoles: { access_role: { id: ROLE_A }, access_role_2: { id: ROLE_A } },
    });
    await cmd.execute(i, ctx);
    const ow = i.__channelsCreate.mock.calls[0][0].permissionOverwrites;
    expect(ow.map((o: any) => o.id)).toEqual([EVERYONE_ID, ROLE_A, BOT_ID]);
  });

  test("private:true with NO access roles: deny everyone + allow bot only; reply says admins-only", async () => {
    const cmd = buildCreateChannelCommand();
    const i = chanInteraction({ name: "secret", type: "text", private: true });
    await cmd.execute(i, ctx);
    const ow = i.__channelsCreate.mock.calls[0][0].permissionOverwrites;
    expect(ow.map((o: any) => o.id)).toEqual([EVERYONE_ID, BOT_ID]);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining("(private)"));
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining("admins"));
  });

  test("non-private: NO permissionOverwrites (even if access roles supplied)", async () => {
    const cmd = buildCreateChannelCommand();
    const i = chanInteraction({
      name: "open",
      type: "text",
      accessRoles: { access_role: { id: ROLE_A } },
    });
    await cmd.execute(i, ctx);
    expect("permissionOverwrites" in i.__channelsCreate.mock.calls[0][0]).toBe(false);
  });

  test("nsfw:true: nsfw passed as true", async () => {
    const cmd = buildCreateChannelCommand();
    const i = chanInteraction({ name: "edgy", type: "text", nsfw: true });
    await cmd.execute(i, ctx);
    expect(i.__channelsCreate.mock.calls[0][0].nsfw).toBe(true);
  });

  test("text type with no topic/slowmode: those keys omitted", async () => {
    const cmd = buildCreateChannelCommand();
    const i = chanInteraction({ name: "bare", type: "text" });
    await cmd.execute(i, ctx);
    const arg = i.__channelsCreate.mock.calls[0][0];
    expect("topic" in arg).toBe(false);
    expect("rateLimitPerUser" in arg).toBe(false);
  });

  test("throws ConfigError when no guild context", async () => {
    const cmd = buildCreateChannelCommand();
    const i = chanInteraction({ name: "x", type: "text" });
    i.guild = null;
    await expect(cmd.execute(i, ctx)).rejects.toThrow(/no guild context/);
  });
});
