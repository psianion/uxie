import { describe, expect, test, mock } from "bun:test";
import { handleInboxMessage } from "../../../src/integrations/scrypt/inbox-handler.ts";
import { fakeMessage } from "../../helpers.ts";
import { ScryptError } from "../../../src/lib/errors.ts";

const logStub = { info: () => {}, warn: () => {}, error: () => {}, child: () => logStub } as any;

describe("handleInboxMessage", () => {
  test("ingests note with kind=note and uxie-msg-<id> tag, reacts ✅", async () => {
    const ingest = mock(async () => ({ path: "notes/inbox/x.md", permalink: "https://s/n/x" }));
    const msg = fakeMessage({ content: "hello world" });
    await handleInboxMessage(msg, { ingest } as any, logStub);
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "note", content: "hello world", clientTag: "uxie-msg-mid-1" }),
    );
    expect(msg.react).toHaveBeenCalledWith("✅");
  });

  test("reacts ❌ on ScryptError and does not throw", async () => {
    const ingest = mock(async () => {
      throw new ScryptError("scrypt_unreachable", "scrypt unreachable");
    });
    const msg = fakeMessage();
    await expect(handleInboxMessage(msg, { ingest } as any, logStub)).resolves.toBeUndefined();
    expect(msg.react).toHaveBeenCalledWith("❌");
  });

  test("never throws even when the ❌ react itself fails", async () => {
    const ingest = mock(async () => {
      throw new ScryptError("scrypt_server", "boom");
    });
    const msg = fakeMessage({
      react: mock(async () => {
        throw new Error("missing add-reactions permission");
      }),
    });
    await expect(handleInboxMessage(msg, { ingest } as any, logStub)).resolves.toBeUndefined();
  });
});
