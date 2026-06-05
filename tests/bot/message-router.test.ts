import { describe, expect, test, mock } from "bun:test";
import { handleMessage } from "../../src/bot/message-router.ts";
import { fakeMessage } from "../helpers.ts";

describe("handleMessage (owner mention gate)", () => {
  const cfg = { ownerId: "123" };

  test("ignores bot authors", async () => {
    const onMention = mock(async () => {});
    await handleMessage(fakeMessage({ author: { id: "123", bot: true }, mentionsBot: true }), cfg, onMention);
    expect(onMention).not.toHaveBeenCalled();
  });

  test("ignores non-owner authors even when they mention uxie", async () => {
    const onMention = mock(async () => {});
    await handleMessage(fakeMessage({ author: { id: "999", bot: false }, mentionsBot: true }), cfg, onMention);
    expect(onMention).not.toHaveBeenCalled();
  });

  test("ignores owner messages that do not mention uxie", async () => {
    const onMention = mock(async () => {});
    await handleMessage(fakeMessage({ author: { id: "123", bot: false }, mentionsBot: false }), cfg, onMention);
    expect(onMention).not.toHaveBeenCalled();
  });

  test("invokes onMention for an owner direct-mention", async () => {
    const onMention = mock(async () => {});
    await handleMessage(fakeMessage({ author: { id: "123", bot: false }, mentionsBot: true }), cfg, onMention);
    expect(onMention).toHaveBeenCalledTimes(1);
  });

  test("does nothing before the client is READY (no client.user)", async () => {
    const onMention = mock(async () => {});
    await handleMessage(
      fakeMessage({ author: { id: "123", bot: false }, mentionsBot: true, client: { user: null } }),
      cfg,
      onMention,
    );
    expect(onMention).not.toHaveBeenCalled();
  });

  test("catch site: a throwing handler never escapes handleMessage", async () => {
    const onMention = mock(async () => {
      throw new Error("handler blew up");
    });
    await expect(
      handleMessage(fakeMessage({ author: { id: "123", bot: false }, mentionsBot: true }), cfg, onMention),
    ).resolves.toBeUndefined();
  });
});
