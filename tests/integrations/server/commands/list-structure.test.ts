import { describe, expect, test, mock } from "bun:test";
import { ChannelType } from "discord.js";
import { buildListStructureCommand } from "../../../../src/integrations/server/commands/list-structure.ts";

const ctx = { clientTag: "uxie-x", log: { info() {}, warn() {}, error() {} } as any };
const V2 = 1 << 15;
const GUILD_ID = "111111111111111111";

function structureInteraction(): any {
  const channels = new Map<string, any>([
    ["c1", { id: "c1", name: "General", type: ChannelType.GuildCategory, parentId: null, position: 0 }],
    ["c2", { id: "c2", name: "chat", type: ChannelType.GuildText, parentId: "c1", position: 0 }],
    ["c3", { id: "c3", name: "voice", type: ChannelType.GuildVoice, parentId: "c1", position: 1 }],
    ["c4", { id: "c4", name: "lobby", type: ChannelType.GuildText, parentId: null, position: 5 }],
    ["c5", null], // uncached entries come back null — must not crash
  ]);
  const roles = new Map<string, any>([
    [GUILD_ID, { id: GUILD_ID, name: "@everyone", position: 0, managed: false }],
    ["r1", { id: "r1", name: "admin", position: 2, managed: false }],
    ["r2", { id: "r2", name: "some-bot", position: 1, managed: true }],
  ]);
  return {
    commandName: "list-structure",
    guild: {
      id: GUILD_ID,
      name: "G",
      channels: { fetch: mock(async () => channels) },
      roles: { fetch: mock(async () => roles) },
    },
    options: {},
    editReply: mock(async (_: unknown) => {}),
  };
}

describe("/list-structure", () => {
  test("renders one V2 panel with category, orphan, and roles rows", async () => {
    const cmd = buildListStructureCommand();
    const i = structureInteraction();
    await cmd.execute(i, ctx);
    const arg = i.editReply.mock.calls[0][0];
    expect(arg.flags & V2).toBe(V2);
    const json = JSON.stringify(arg.components[0].toJSON());
    expect(json).toContain("General"); // category row
    expect(json).toContain("(no category)"); // orphan row
    expect(json).toContain("some-bot*"); // managed role marked
    expect(json).not.toContain("@everyone"); // @everyone omitted from role list
  });
});
