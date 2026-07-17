import { describe, expect, test, mock } from "bun:test";
import { ChannelType } from "discord.js";
import { buildDeleteChannelCommand } from "../../../../src/integrations/server/commands/delete-channel.ts";
import { ConfigError } from "../../../../src/lib/errors.ts";

const ctx = { clientTag: "uxie-x", log: { info() {}, warn() {}, error() {} } as any };
const V2 = 1 << 15;

function delInteraction(opts: {
  confirm?: boolean;
  type?: ChannelType;
  reason?: string | null;
} = {}): any {
  const channelsDelete = mock(async (_id: string, _r?: string) => {});
  return {
    commandName: "delete-channel",
    guild: { name: "G", channels: { delete: channelsDelete } },
    options: {
      getChannel: mock(() => ({
        id: "888",
        name: "doomed",
        type: opts.type ?? ChannelType.GuildText,
      })),
      getBoolean: mock(() => opts.confirm ?? false),
      getString: mock(() => opts.reason ?? null),
    },
    editReply: mock(async (_: unknown) => {}),
    __channelsDelete: channelsDelete,
  };
}

describe("/delete-channel", () => {
  test("builder: confirm option required", () => {
    const cmd = buildDeleteChannelCommand();
    const json = (cmd.data as any).toJSON();
    const confirm = json.options.find((o: any) => o.name === "confirm");
    expect(confirm.required).toBe(true);
  });

  test("confirm=false → ConfigError, nothing deleted", async () => {
    const cmd = buildDeleteChannelCommand();
    const i = delInteraction({ confirm: false });
    await expect(cmd.execute(i, ctx)).rejects.toThrow(ConfigError);
    expect(i.__channelsDelete).not.toHaveBeenCalled();
  });

  test("confirm=true deletes and renders V2 panel with snapshotted name", async () => {
    const cmd = buildDeleteChannelCommand();
    const i = delInteraction({ confirm: true, reason: "cleanup" });
    await cmd.execute(i, ctx);
    expect(i.__channelsDelete).toHaveBeenCalledWith("888", "cleanup");
    const arg = i.editReply.mock.calls[0][0];
    expect(arg.flags & V2).toBe(V2);
  });

  test("category target adds the children-re-homed note", async () => {
    const cmd = buildDeleteChannelCommand();
    const i = delInteraction({ confirm: true, type: ChannelType.GuildCategory });
    await cmd.execute(i, ctx);
    expect(i.__channelsDelete).toHaveBeenCalled();
  });
});
