import { describe, expect, test, mock } from "bun:test";
import { buildJournalCommand } from "../../../../src/integrations/scrypt/commands/journal.ts";
import { ScryptError } from "../../../../src/lib/errors.ts";
import { fakeInteraction } from "../../../helpers.ts";

const ctx = { clientTag: "uxie-iid-1", log: { info() {}, warn() {}, error() {} } as any };

const BUNDLE = {
  date: "2026-07-16",
  entries: [
    { id: "2026-07-16T08:00:00.000Z", displayTime: "8:00 AM", body: "earlier" },
    { id: "2026-07-16T09:30:00.000Z", displayTime: "9:30 AM", body: "hello" },
  ],
  tasks_due: [],
  related: [],
};

function journalInteraction(text = "hello") {
  return fakeInteraction({
    deferred: true,
    options: { getString: mock((_: string, _req?: boolean) => text) },
  });
}

describe("/journal", () => {
  test("command data name is 'journal' with default builder shape (decision 7)", () => {
    const cmd = buildJournalCommand({} as any);
    expect(cmd.data.name).toBe("journal");
    expect((cmd.data as any).toJSON().default_member_permissions).toBe("0");
  });

  test("appends via journalEntry and confirms with date, entry number, and day file", async () => {
    const journalEntry = mock(async () => BUNDLE);
    const cmd = buildJournalCommand({ journalEntry } as any);
    const i = journalInteraction("hello");
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
    await expect(cmd.execute(journalInteraction(), ctx)).rejects.toBeInstanceOf(ScryptError);
  });
});
