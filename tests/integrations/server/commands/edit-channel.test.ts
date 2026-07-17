import { describe, expect, test, mock } from "bun:test";
import { buildEditChannelCommand } from "../../../../src/integrations/server/commands/edit-channel.ts";
import { ConfigError } from "../../../../src/lib/errors.ts";

const ctx = { clientTag: "uxie-x", log: { info() {}, warn() {}, error() {} } as any };
const V2 = 1 << 15;

function editInteraction(opts: {
  name?: string | null;
  topic?: string | null;
  slowmode?: number | null;
  nsfw?: boolean | null;
  category?: { id: string; name: string } | null;
  position?: number | null;
  reason?: string | null;
} = {}): any {
  const edited = { id: "777", name: opts.name ?? "chan" };
  const channelsEdit = mock(async (_id: string, _e: unknown) => edited);
  return {
    commandName: "edit-channel",
    guild: { name: "G", channels: { edit: channelsEdit } },
    options: {
      getChannel: mock((n: string, _req?: boolean) =>
        n === "channel" ? { id: "777", name: "chan" } : opts.category ?? null,
      ),
      getString: mock((n: string) =>
        n === "name" ? opts.name ?? null : n === "topic" ? opts.topic ?? null : opts.reason ?? null,
      ),
      getInteger: mock((n: string) =>
        n === "slowmode" ? opts.slowmode ?? null : opts.position ?? null,
      ),
      getBoolean: mock(() => opts.nsfw ?? null),
    },
    editReply: mock(async (_: unknown) => {}),
    __channelsEdit: channelsEdit,
  };
}

describe("/edit-channel", () => {
  test("builder: auto-defer (no defer:false), name is edit-channel", () => {
    const cmd = buildEditChannelCommand();
    expect(cmd.defer).toBeUndefined();
    expect(cmd.data.name).toBe("edit-channel");
  });

  test("no options → ConfigError, no edit call", async () => {
    const cmd = buildEditChannelCommand();
    const i = editInteraction();
    await expect(cmd.execute(i, ctx)).rejects.toThrow(ConfigError);
    expect(i.__channelsEdit).not.toHaveBeenCalled();
  });

  test("reason alone still counts as no change", async () => {
    const cmd = buildEditChannelCommand();
    const i = editInteraction({ reason: "why" });
    await expect(cmd.execute(i, ctx)).rejects.toThrow(ConfigError);
  });

  test("partial edit sends ONLY provided keys and renders V2 panel", async () => {
    const cmd = buildEditChannelCommand();
    const i = editInteraction({ topic: "new topic", slowmode: 30 });
    await cmd.execute(i, ctx);
    expect(i.__channelsEdit).toHaveBeenCalledWith("777", {
      topic: "new topic",
      rateLimitPerUser: 30,
    });
    const arg = i.editReply.mock.calls[0][0];
    expect(arg.flags & V2).toBe(V2);
  });

  test("slowmode 0 (falsy) is still sent — disables slowmode", async () => {
    const cmd = buildEditChannelCommand();
    const i = editInteraction({ slowmode: 0 });
    await cmd.execute(i, ctx);
    expect(i.__channelsEdit).toHaveBeenCalledWith("777", { rateLimitPerUser: 0 });
  });
});
