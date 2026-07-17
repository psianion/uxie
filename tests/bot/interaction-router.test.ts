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
import { fakeInteraction, fakeButton, fakeMessageCommandInteraction } from "../helpers.ts";
import type { LoadedCommand } from "../../src/bot/command-loader.ts";
import type { ComponentHandler } from "../../src/bot/interaction-router.ts";

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

  test("does NOT defer when the command opts out (defer:false)", async () => {
    const execute = mock(async () => {});
    const c = new Collection<string, LoadedCommand>();
    c.set("ping", { data: { name: "ping" } as any, execute, defer: false });
    const i = fakeInteraction();
    await handleInteraction(i, c, "123");
    expect(i.deferReply).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalled();
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

describe("handleInteraction — buttons", () => {
  function handlers(handle: ComponentHandler["handle"]): Collection<string, ComponentHandler> {
    const c = new Collection<string, ComponentHandler>();
    c.set("ping", { namespace: "ping", handle });
    return c;
  }

  test("dispatches an owner button in the dev guild to its namespace handler", async () => {
    const handle = mock(async () => {});
    const i = fakeButton();
    await handleInteraction(i, makeCommands(mock(async () => {})), "123", {
      components: handlers(handle),
      devGuildId: "guild-1",
    });
    expect(handle).toHaveBeenCalled();
  });

  test("non-owner button is refused (handler not run)", async () => {
    const handle = mock(async () => {});
    const i = fakeButton({ user: { id: "999" } });
    await handleInteraction(i, makeCommands(mock(async () => {})), "123", {
      components: handlers(handle),
      devGuildId: "guild-1",
    });
    expect(handle).not.toHaveBeenCalled();
  });

  test("wrong-guild button is refused even for the owner", async () => {
    const handle = mock(async () => {});
    const i = fakeButton({ guildId: "other-guild" });
    await handleInteraction(i, makeCommands(mock(async () => {})), "123", {
      components: handlers(handle),
      devGuildId: "guild-1",
    });
    expect(handle).not.toHaveBeenCalled();
  });

  test("unknown namespace is ignored", async () => {
    const handle = mock(async () => {});
    const i = fakeButton({ customId: "other:thing" });
    await handleInteraction(i, makeCommands(mock(async () => {})), "123", {
      components: handlers(handle),
      devGuildId: "guild-1",
    });
    expect(handle).not.toHaveBeenCalled();
  });

  test("a throwing handler never escapes (decision 10)", async () => {
    const handle = mock(async () => {
      throw new Error("boom");
    });
    const i = fakeButton();
    await expect(
      handleInteraction(i, makeCommands(mock(async () => {})), "123", {
        components: handlers(handle),
        devGuildId: "guild-1",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("handleInteraction — onboarding buttons", () => {
  function onboardingStub() {
    return {
      handleRolePick: mock(async (_i: unknown) => {}),
      handleApprovalButton: mock(async (_i: unknown, _ownerId?: string) => {}),
    };
  }

  test("onboard:pick routes to handleRolePick (not approval, not the generic gate)", async () => {
    const onboarding = onboardingStub();
    const i = fakeButton({ customId: "onboard:pick:111111111111111111", user: { id: "999" } });
    await handleInteraction(i, makeCommands(mock(async () => {})), "123", { onboarding });
    expect(onboarding.handleRolePick).toHaveBeenCalledTimes(1);
    expect(onboarding.handleApprovalButton).not.toHaveBeenCalled();
  });

  test("onboard:approve routes to handleApprovalButton with the ownerId", async () => {
    const onboarding = onboardingStub();
    const i = fakeButton({
      customId: "onboard:approve:111111111111111111:222222222222222222",
    });
    await handleInteraction(i, makeCommands(mock(async () => {})), "123", { onboarding });
    expect(onboarding.handleApprovalButton).toHaveBeenCalledTimes(1);
    expect(onboarding.handleApprovalButton.mock.calls[0]?.[1]).toBe("123");
    expect(onboarding.handleRolePick).not.toHaveBeenCalled();
  });

  test("onboard:deny routes to handleApprovalButton", async () => {
    const onboarding = onboardingStub();
    const i = fakeButton({
      customId: "onboard:deny:111111111111111111:222222222222222222",
    });
    await handleInteraction(i, makeCommands(mock(async () => {})), "123", { onboarding });
    expect(onboarding.handleApprovalButton).toHaveBeenCalledTimes(1);
  });

  test("onboarding bypasses the owner gate — a non-owner role-pick still dispatches", async () => {
    // Guests (non-owners) MUST be able to click role buttons; the handler self-gates.
    const onboarding = onboardingStub();
    const i = fakeButton({ customId: "onboard:pick:111111111111111111", user: { id: "999" } });
    await handleInteraction(i, makeCommands(mock(async () => {})), "123", {
      components: new Collection(),
      devGuildId: "guild-1",
      onboarding,
    });
    expect(onboarding.handleRolePick).toHaveBeenCalledTimes(1);
  });

  test("unknown onboard: action does nothing", async () => {
    const onboarding = onboardingStub();
    const i = fakeButton({ customId: "onboard:bogus:1" });
    await handleInteraction(i, makeCommands(mock(async () => {})), "123", { onboarding });
    expect(onboarding.handleRolePick).not.toHaveBeenCalled();
    expect(onboarding.handleApprovalButton).not.toHaveBeenCalled();
  });

  test("a non-onboard button does not reach the onboarding handlers", async () => {
    const onboarding = onboardingStub();
    const i = fakeButton({ customId: "ping:refresh" });
    await handleInteraction(i, makeCommands(mock(async () => {})), "123", { onboarding });
    expect(onboarding.handleRolePick).not.toHaveBeenCalled();
    expect(onboarding.handleApprovalButton).not.toHaveBeenCalled();
  });

  test("a throwing onboarding handler never escapes (decision 10)", async () => {
    const onboarding = {
      handleRolePick: mock(async () => {
        throw new Error("boom");
      }),
      handleApprovalButton: mock(async () => {}),
    };
    const i = fakeButton({ customId: "onboard:pick:111111111111111111" });
    await expect(
      handleInteraction(i, makeCommands(mock(async () => {})), "123", { onboarding }),
    ).resolves.toBeUndefined();
  });

  test("a chat-input command still flows through the existing path", async () => {
    const onboarding = onboardingStub();
    const execute = mock(async () => {});
    const i = fakeInteraction();
    await handleInteraction(i, makeCommands(execute), "123", { onboarding });
    expect(execute).toHaveBeenCalled();
    expect(onboarding.handleRolePick).not.toHaveBeenCalled();
  });
});

describe("handleInteraction — message context-menu commands", () => {
  function makeMessageCommands(execute: (i: any, ctx: any) => Promise<void>) {
    const c = new Collection<string, any>();
    c.set("Triage", { data: { name: "Triage" } as any, execute });
    return c;
  }

  test("dispatches after deferring ephemerally (same contract as slash commands)", async () => {
    const execute = mock(async () => {});
    const i = fakeMessageCommandInteraction();
    await handleInteraction(i, new Collection(), "123", {
      messageCommands: makeMessageCommands(execute),
    });
    expect(i.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(execute).toHaveBeenCalled();
  });

  test("non-owner is refused pre-defer (decision 9)", async () => {
    const execute = mock(async () => {});
    const i = fakeMessageCommandInteraction({ user: { id: "999" } });
    await handleInteraction(i, new Collection(), "123", {
      messageCommands: makeMessageCommands(execute),
    });
    expect(execute).not.toHaveBeenCalled();
    expect(i.deferReply).not.toHaveBeenCalled();
    expect(i.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("not for you") }),
    );
  });

  test("a throwing message command is caught and acked (decision 10)", async () => {
    const execute = mock(async () => {
      throw new UxieError("boom", "it broke");
    });
    const i = fakeMessageCommandInteraction();
    await expect(
      handleInteraction(i, new Collection(), "123", {
        messageCommands: makeMessageCommands(execute),
      }),
    ).resolves.toBeUndefined();
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining("it broke"));
  });

  test("no messageCommands registered → ignored silently", async () => {
    const i = fakeMessageCommandInteraction();
    await handleInteraction(i, new Collection(), "123", {});
    expect(i.deferReply).not.toHaveBeenCalled();
  });
});
