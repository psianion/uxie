import { describe, expect, test, mock } from "bun:test";
import { handleMessage } from "../../src/bot/message-router.ts";
import { fakeMessage } from "../helpers.ts";

describe("handleMessage", () => {
  const cfg = { ownerId: "123", inboxId: "inbox-chan" };

  test("ignores bot messages", async () => {
    const handler = mock(async () => {});
    const msg = fakeMessage({ author: { id: "123", bot: true } });
    await handleMessage(msg, cfg, handler);
    expect(handler).not.toHaveBeenCalled();
  });

  test("ignores non-owner messages", async () => {
    const handler = mock(async () => {});
    const msg = fakeMessage({ author: { id: "999", bot: false } });
    await handleMessage(msg, cfg, handler);
    expect(handler).not.toHaveBeenCalled();
  });

  test("ignores messages outside inbox channel", async () => {
    const handler = mock(async () => {});
    const msg = fakeMessage({ channelId: "other" });
    await handleMessage(msg, cfg, handler);
    expect(handler).not.toHaveBeenCalled();
  });

  test("ignores empty / whitespace-only messages", async () => {
    const handler = mock(async () => {});
    const msg = fakeMessage({ content: "   " });
    await handleMessage(msg, cfg, handler);
    expect(handler).not.toHaveBeenCalled();
  });

  test("calls handler on a valid owner inbox message", async () => {
    const handler = mock(async () => {});
    const msg = fakeMessage();
    await handleMessage(msg, cfg, handler);
    expect(handler).toHaveBeenCalledWith(msg);
  });

  test("catch site: a throwing handler never escapes handleMessage", async () => {
    const handler = mock(async () => {
      throw new Error("ingest blew up");
    });
    const msg = fakeMessage();
    // Must resolve, not reject — message-router is catch site #2 (decision 10).
    await expect(handleMessage(msg, cfg, handler)).resolves.toBeUndefined();
  });
});
