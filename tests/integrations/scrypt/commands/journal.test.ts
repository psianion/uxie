import { describe, expect, test, mock } from "bun:test";
import { buildJournalCommand } from "../../../../src/integrations/scrypt/commands/journal.ts";
import { buildJournalComponentHandler } from "../../../../src/integrations/scrypt/journal/handler.ts";
import { ConfigError, ScryptError } from "../../../../src/lib/errors.ts";
import { utcToday } from "../../../../src/integrations/scrypt/rest-client.ts";
import { fakeButton, fakeInteraction } from "../../../helpers.ts";

const ctx = { clientTag: "uxie-iid-1", log: { info() {}, warn() {}, error() {} } as any };
const V2 = 1 << 15;

const ADD_BUNDLE = {
  date: "2026-07-16",
  entries: [
    { id: "2026-07-16T08:00:00.000Z", displayTime: "8:00 AM", body: "earlier" },
    { id: "2026-07-16T09:30:00.000Z", displayTime: "9:30 AM", body: "hello" },
  ],
  tasks_due: [],
  related: [],
};

const READ_BUNDLE = {
  date: "2026-07-15",
  entries: [{ id: "2026-07-15T10:00:00.000Z", displayTime: "10:00 AM", body: "a".repeat(300) }],
  tasks_due: [],
  related: [],
};

// options bag carrying getSubcommand + getString for the two-leg command.
function journalInteraction(sub: string, opts: Record<string, string | null> = {}) {
  return fakeInteraction({
    deferred: true,
    options: {
      getSubcommand: mock(() => sub),
      getString: mock((name: string, _req?: boolean) => opts[name] ?? null),
    },
  });
}

describe("/journal (builder)", () => {
  test("command data name is 'journal' with default builder shape (decision 7)", () => {
    const cmd = buildJournalCommand({} as any);
    expect(cmd.data.name).toBe("journal");
    expect((cmd.data as any).toJSON().default_member_permissions).toBe("0");
  });

  test("exposes add + read subcommands", () => {
    const cmd = buildJournalCommand({} as any);
    const names = (cmd.data as any).toJSON().options.map((o: any) => o.name);
    expect(names).toEqual(["add", "read"]);
  });
});

describe("/journal add", () => {
  test("appends via journalEntry and confirms with date, entry number, and day file", async () => {
    const journalEntry = mock(async () => ADD_BUNDLE);
    const cmd = buildJournalCommand({ journalEntry } as any);
    const i = journalInteraction("add", { text: "hello" });
    await cmd.execute(i, ctx);
    expect(journalEntry).toHaveBeenCalledWith("hello", "uxie-iid-1");
    const msg = i.editReply.mock.calls[0][0] as string;
    expect(msg).toContain("journal 2026-07-16 — entry #2 added");
    expect(msg).toContain("`journal/2026-07-16.md`");
    // the appended entry's UTC instant rendered as a Discord timestamp (viewer-local)
    expect(msg).toContain(`<t:${Math.floor(Date.parse("2026-07-16T09:30:00.000Z") / 1000)}:t>`);
  });

  test("a ScryptError bubbles to the router (scrypt down)", async () => {
    const journalEntry = mock(async () => {
      throw new ScryptError("scrypt_unreachable", "scrypt unreachable");
    });
    const cmd = buildJournalCommand({ journalEntry } as any);
    await expect(cmd.execute(journalInteraction("add", { text: "x" }), ctx)).rejects.toBeInstanceOf(
      ScryptError,
    );
  });
});

describe("/journal read", () => {
  test("renders the day panel (V2), clipping long entry bodies", async () => {
    const journalDay = mock(async () => READ_BUNDLE);
    const cmd = buildJournalCommand({ journalDay } as any);
    const i = journalInteraction("read", { date: "2026-07-15" });
    await cmd.execute(i, ctx);
    expect(journalDay).toHaveBeenCalledWith("2026-07-15", "uxie-iid-1");
    const payload = i.editReply.mock.calls[0][0];
    expect(payload.flags & V2).toBe(V2);
    const json = JSON.stringify(payload.components[0].toJSON());
    expect(json).toContain("Journal · 2026-07-15");
    expect(json).toContain("10:00 AM");
    expect(json).toContain("…"); // 300-char body was clipped
  });

  test("defaults date to utcToday() when omitted", async () => {
    const journalDay = mock(async () => ({ ...READ_BUNDLE, date: utcToday() }));
    const cmd = buildJournalCommand({ journalDay } as any);
    await cmd.execute(journalInteraction("read"), ctx);
    expect(journalDay).toHaveBeenCalledWith(utcToday(), "uxie-iid-1");
  });

  test("rejects a malformed date with ConfigError", async () => {
    const cmd = buildJournalCommand({ journalDay: mock(async () => READ_BUNDLE) } as any);
    await expect(
      cmd.execute(journalInteraction("read", { date: "07/15/2026" }), ctx),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("journal:day component handler", () => {
  test("updates the message with the fetched day on click", async () => {
    const journalDay = mock(async () => READ_BUNDLE);
    const h = buildJournalComponentHandler({ journalDay } as any);
    const i = fakeButton({ customId: "journal:day:2026-07-15" });
    await h.handle(i, ctx);
    expect(journalDay).toHaveBeenCalledWith("2026-07-15");
    expect(i.update).toHaveBeenCalled();
    const json = JSON.stringify(i.update.mock.calls[0][0].components[0].toJSON());
    expect(json).toContain("Journal · 2026-07-15");
  });
});
