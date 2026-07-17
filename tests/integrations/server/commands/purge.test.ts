import { describe, expect, test, mock } from "bun:test";
import { ChannelType } from "discord.js";
import { buildPurgeCommand } from "../../../../src/integrations/server/commands/purge.ts";

const ctx = { clientTag: "uxie-x", log: { info() {}, warn() {}, error() {} } as any };
const V2 = 1 << 15;

function purgeInteraction(opts: {
  count?: number;
  user?: { id: string } | null;
  deletedSize?: number;
  recentAuthors?: string[]; // author ids of the last-100 fetch, newest first
} = {}): any {
  const bulkDelete = mock(async (arg: number | unknown[], _filterOld?: boolean) => ({
    size: opts.deletedSize ?? (typeof arg === "number" ? arg : (arg as unknown[]).length),
  }));
  const recent = new Map(
    (opts.recentAuthors ?? []).map((a, idx) => [`m${idx}`, { author: { id: a } }]),
  );
  const channel = {
    id: "444",
    type: ChannelType.GuildText,
    bulkDelete,
    messages: { fetch: mock(async (_: unknown) => recent) },
  };
  return {
    commandName: "purge",
    guild: { name: "G", channels: { fetch: mock(async () => channel) } },
    options: {
      getChannel: mock(() => ({ id: "444" })),
      getInteger: mock(() => opts.count ?? 10),
      getUser: mock(() => opts.user ?? null),
    },
    editReply: mock(async (_: unknown) => {}),
    __bulkDelete: bulkDelete,
  };
}

describe("/purge", () => {
  test("builder: count required with 1-100 bounds", () => {
    const cmd = buildPurgeCommand();
    const json = (cmd.data as any).toJSON();
    const count = json.options.find((o: any) => o.name === "count");
    expect(count.required).toBe(true);
    expect(count.min_value).toBe(1);
    expect(count.max_value).toBe(100);
  });

  test("no user filter: bulkDelete(count, true)", async () => {
    const cmd = buildPurgeCommand();
    const i = purgeInteraction({ count: 25 });
    await cmd.execute(i, ctx);
    expect(i.__bulkDelete).toHaveBeenCalledWith(25, true);
    const arg = i.editReply.mock.calls[0][0];
    expect(arg.flags & V2).toBe(V2);
  });

  test("user filter: deletes only that author's messages from the last 100", async () => {
    const cmd = buildPurgeCommand();
    const i = purgeInteraction({
      count: 2,
      user: { id: "u1" },
      recentAuthors: ["u1", "u2", "u1", "u1"],
    });
    await cmd.execute(i, ctx);
    const [passed, filterOld] = i.__bulkDelete.mock.calls[0];
    expect(Array.isArray(passed)).toBe(true);
    expect(passed.length).toBe(2); // capped at count even though u1 has 3
    expect(filterOld).toBe(true);
  });
});
