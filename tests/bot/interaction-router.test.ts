import { describe, expect, test, mock } from "bun:test";
import { Collection, MessageFlags } from "discord.js";
import { handleInteraction } from "../../src/bot/interaction-router.ts";
import {
  NotOwnerError,
  ScryptError,
  ScryptTimeoutError,
  ScryptAuthError,
  ScryptBadRequestError,
  UxieError,
} from "../../src/lib/errors.ts";
import { fakeInteraction } from "../helpers.ts";
import type { LoadedCommand } from "../../src/bot/command-loader.ts";

function makeCommands(execute: LoadedCommand["execute"]): Collection<string, LoadedCommand> {
  const c = new Collection<string, LoadedCommand>();
  c.set("ping", { data: { name: "ping" } as any, execute });
  return c;
}

describe("handleInteraction", () => {
  test("dispatches to matching command after deferring", async () => {
    const execute = mock(async () => {});
    const i = fakeInteraction();
    await handleInteraction(i, makeCommands(execute), "123");
    expect(i.deferReply).toHaveBeenCalled();
    expect(execute).toHaveBeenCalled();
  });

  test("defers ephemerally with MessageFlags.Ephemeral, never boolean (decision 8)", async () => {
    const execute = mock(async () => {});
    const i = fakeInteraction();
    await handleInteraction(i, makeCommands(execute), "123");
    expect(i.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  });

  test("ignores non-chat-input interactions", async () => {
    const execute = mock(async () => {});
    const i = fakeInteraction({ isChatInputCommand: () => false });
    await handleInteraction(i, makeCommands(execute), "123");
    expect(execute).not.toHaveBeenCalled();
  });

  test("ignores unknown commands", async () => {
    const execute = mock(async () => {});
    const i = fakeInteraction({ commandName: "unknown" });
    await handleInteraction(i, makeCommands(execute), "123");
    expect(execute).not.toHaveBeenCalled();
  });

  test("non-owner gets ephemeral reply via i.reply, command not run (decision 9)", async () => {
    const execute = mock(async () => {});
    const i = fakeInteraction({ user: { id: "999" } });
    await handleInteraction(i, makeCommands(execute), "123");
    expect(execute).not.toHaveBeenCalled();
    expect(i.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("not for you"),
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test("gate fires BEFORE defer — non-owner is never deferred (decision 9)", async () => {
    const execute = mock(async () => {});
    const i = fakeInteraction({ user: { id: "999" } });
    await handleInteraction(i, makeCommands(execute), "123");
    expect(i.deferReply).not.toHaveBeenCalled();
  });

  // 7.3 error-mapping contract — each error subclass maps to a user-facing editReply
  // string on the deferred interaction.
  test.each([
    [new ScryptError("scrypt_unreachable", "scrypt unreachable"), "scrypt unreachable"],
    [new ScryptTimeoutError("scrypt_timeout", "scrypt timed out"), "scrypt timed out"],
    [new ScryptAuthError("scrypt_auth", "scrypt auth rejected"), "scrypt auth rejected"],
    [new ScryptBadRequestError("scrypt_bad_request", "scrypt: bad input"), "bad input"],
  ])("ScryptError subclass maps to its message via editReply", async (err, expected) => {
    const execute = mock(async () => {
      throw err;
    });
    const i = fakeInteraction();
    await handleInteraction(i, makeCommands(execute), "123");
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining(expected as string));
  });

  test("generic UxieError maps to a prefixed message via editReply", async () => {
    const execute = mock(async () => {
      throw new UxieError("weird", "something odd");
    });
    const i = fakeInteraction();
    await handleInteraction(i, makeCommands(execute), "123");
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining("something odd"));
  });

  test("unknown error becomes generic crash message via editReply", async () => {
    const execute = mock(async () => {
      throw new Error("boom");
    });
    const i = fakeInteraction();
    await handleInteraction(i, makeCommands(execute), "123");
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining("uxie crashed"));
  });

  test("error before defer (NotOwnerError path tested above) — Scrypt error pre-defer uses reply", async () => {
    // If a non-owner somehow throws a ScryptError before defer it should still reply, not editReply.
    const execute = mock(async () => {
      throw new ScryptError("scrypt_unreachable", "scrypt unreachable");
    });
    const i = fakeInteraction({ deferReply: mock(async () => {}) }); // never flips deferred
    await handleInteraction(i, makeCommands(execute), "123");
    expect(i.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("scrypt unreachable") }),
    );
  });

  test("replyWithError never throws even if the reply itself rejects (decision 10)", async () => {
    const execute = mock(async () => {
      throw new Error("boom");
    });
    const i = fakeInteraction({
      editReply: mock(async () => {
        throw new Error("discord 10062 unknown interaction");
      }),
    });
    // Must resolve, not reject — the defensive .catch() inside replyWithError swallows it.
    await expect(handleInteraction(i, makeCommands(execute), "123")).resolves.toBeUndefined();
  });
});
