// Catch site #1 of 3 (ratified decision 10): the whole-body try/catch for every slash
// command. Command bodies stay try/catch-free; all faults funnel here.
//
// Owner gate is ROUTER-LOCATED and fires BEFORE deferReply (decision 9): a non-owner is
// rejected with i.reply (NOT editReply) and the command never runs / never defers.
//
// Every ephemeral payload uses { flags: MessageFlags.Ephemeral } — never the deprecated
// boolean ephemeral:true (decision 8). replyWithError can never throw: each Discord call
// is defensively .catch()ed (decision 10) so a failed acknowledgement (e.g. a 10062
// expired interaction) can't escape into the gateway dispatcher.
import {
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Collection,
  type Interaction,
  type MessageContextMenuCommandInteraction,
} from "discord.js";
import { UxieError, NotOwnerError, ScryptError } from "../lib/errors.ts";
import { assertOwner } from "../lib/auth.ts";
import { makeClientTag } from "../lib/client-tag.ts";
import { log } from "../lib/log.ts";
import type { LoadedCommand, MessageCommand } from "./command-loader.ts";
import type { OnboardingHandlers } from "../integrations/onboarding/index.ts";

interface ScopedLogger {
  info: (m: string, f?: Record<string, unknown>) => void;
  warn: (m: string, f?: Record<string, unknown>) => void;
  error: (m: string, f?: Record<string, unknown>) => void;
}

// A namespaced button handler. The router owns the owner + dev-guild gate; the handler
// only runs once those pass. `tuning` lets tests shrink auto-retry delays/attempts.
export interface ComponentHandler {
  namespace: string;
  handle(
    i: ButtonInteraction,
    ctx: { log: ScopedLogger },
    tuning?: { delayMs?: number; maxAttempts?: number },
  ): Promise<void>;
}

export interface RouterOpts {
  components?: Collection<string, ComponentHandler>;
  devGuildId?: string;
  // Message context-menu commands (right-click → Apps). Same gate/defer/catch as slash commands.
  messageCommands?: Collection<string, MessageCommand>;
  // Onboarding button handlers. The `onboard:` namespace self-gates (guests may click role
  // buttons; the approval-handler enforces owner-only internally), so it is dispatched BEFORE
  // the owner + dev-guild-gated generic component path — NOT through it.
  onboarding?: OnboardingHandlers;
}

export async function handleInteraction(
  i: Interaction,
  commands: Collection<string, LoadedCommand>,
  ownerId: string,
  opts: RouterOpts = {},
): Promise<void> {
  if (i.isButton()) {
    await handleButton(i, ownerId, opts);
    return;
  }
  if (i.isMessageContextMenuCommand()) {
    await handleMessageCommand(i, ownerId, opts);
    return;
  }
  if (!i.isChatInputCommand()) return;
  const cmd = commands.get(i.commandName);
  if (!cmd) return;

  const ci = i as ChatInputCommandInteraction;
  const clientTag = makeClientTag(i);
  const scoped = log.child({ interactionId: i.id, command: i.commandName, clientTag });

  try {
    // Decision 9: gate BEFORE defer. Non-owner -> NotOwnerError -> pre-defer i.reply path.
    assertOwner(i, ownerId);
    scoped.info("command start");
    // Components V2 commands (defer:false) must set IsComponentsV2 at reply time, which a
    // pre-created deferred placeholder can't carry — so they own their single reply.
    if (cmd.defer !== false) {
      await ci.deferReply({ flags: MessageFlags.Ephemeral });
    }
    await cmd.execute(ci, { clientTag, log: scoped });
    // notice, not info: "command ok" is a notable event the Discord log sink mirrors.
    scoped.notice("command ok");
  } catch (err) {
    await replyWithError(ci, err, scoped);
  }
}

// Message context-menu dispatch: identical contract to slash commands (gate before defer,
// auto-defer ephemeral, single catch site). Kept as its own function only because the
// interaction type differs — MessageCommand has no defer:false escape hatch (none needs it).
async function handleMessageCommand(
  i: MessageContextMenuCommandInteraction,
  ownerId: string,
  opts: RouterOpts,
): Promise<void> {
  const cmd = opts.messageCommands?.get(i.commandName);
  if (!cmd) return;

  const clientTag = makeClientTag(i);
  const scoped = log.child({ interactionId: i.id, command: i.commandName, clientTag });

  try {
    assertOwner(i, ownerId);
    scoped.info("command start");
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    await cmd.execute(i, { clientTag, log: scoped });
    scoped.notice("command ok");
  } catch (err) {
    await replyWithError(i, err, scoped);
  }
}

// Owner + dev-guild gated component dispatch (decision 9, extended to buttons). NEVER
// throws (decision 10): a failing handler is logged and best-effort acknowledged.
async function handleButton(i: ButtonInteraction, ownerId: string, opts: RouterOpts): Promise<void> {
  const scoped = log.child({ interactionId: i.id, customId: i.customId });

  // Onboarding namespace: the role-pick handler ACKs guests (any member may click), and the
  // approval handler enforces owner-only itself — so onboarding bypasses the generic owner +
  // dev-guild gate below. The router stays thin (it only dispatches by customId prefix); the
  // handlers carry NO try/catch (faults bubble) and are caught here, the single button catch
  // site (decision 10), so nothing escapes the gateway.
  const onboarding = opts.onboarding;
  if (onboarding && i.customId.startsWith("onboard:")) {
    try {
      if (i.customId.startsWith("onboard:pick:")) {
        await onboarding.handleRolePick(i);
      } else if (
        i.customId.startsWith("onboard:approve:") ||
        i.customId.startsWith("onboard:deny:")
      ) {
        await onboarding.handleApprovalButton(i, ownerId);
      }
      scoped.notice("button ok");
      // Unknown onboard: actions fall through and return without action.
    } catch (err) {
      scoped.warn("onboarding handler error", { err });
      // Best-effort ack; swallow (e.g. a 10062 expired interaction) so nothing escapes. If the
      // handler already deferred/replied (e.g. role-pick deferReply, then the post threw), edit
      // that reply instead of attempting a second reply that would itself fail.
      const recover =
        i.deferred || i.replied
          ? i.editReply({ content: "couldn't do that" })
          : i.reply({ content: "couldn't do that", flags: MessageFlags.Ephemeral });
      await recover.catch(() => {});
    }
    return;
  }

  const handlers = opts.components;
  if (!handlers) return;
  const namespace = i.customId.split(":")[0] ?? "";
  const handler = handlers.get(namespace);
  if (!handler) return;
  try {
    assertOwner(i, ownerId); // throws NotOwnerError for a non-owner
    if (opts.devGuildId && i.guildId !== opts.devGuildId) {
      throw new NotOwnerError("wrong_guild", "not for you");
    }
    await handler.handle(i, { log: scoped });
  } catch (err) {
    scoped.warn("component handler error", { err });
    // Best-effort ack; swallow (e.g. a 10062 expired interaction) so nothing escapes.
    await i
      .reply({ content: "couldn't do that", flags: MessageFlags.Ephemeral })
      .catch(() => {});
  }
}

// Both command interaction shapes share the ack surface replyWithError needs.
type RepliableCommand = ChatInputCommandInteraction | MessageContextMenuCommandInteraction;

// Maps an error to a user-facing message and acknowledges the interaction. NEVER throws:
// each Discord call is wrapped in safeReply / safeEdit which swallow their own rejection.
async function replyWithError(
  i: RepliableCommand,
  err: unknown,
  scoped: ScopedLogger,
): Promise<void> {
  if (err instanceof NotOwnerError) {
    scoped.info("not owner");
    // Pre-defer path: the gate ran before defer, so use reply, not editReply.
    if (!i.deferred && !i.replied) {
      await safeReply(i, "not for you");
    }
    return;
  }
  if (err instanceof ScryptError) {
    scoped.warn("scrypt error", { err });
    await ack(i, err.message);
    return;
  }
  if (err instanceof UxieError) {
    scoped.warn("uxie error", { err });
    await ack(i, `uxie: ${err.message}`);
    return;
  }
  scoped.error("unhandled", { err });
  await ack(i, "uxie crashed, check logs");
}

// editReply if we already deferred, otherwise an ephemeral reply.
async function ack(i: RepliableCommand, msg: string): Promise<void> {
  if (i.deferred) {
    await safeEdit(i, msg);
  } else {
    await safeReply(i, msg);
  }
}

async function safeEdit(i: RepliableCommand, msg: string): Promise<void> {
  await i.editReply(msg).catch(() => {});
}

async function safeReply(i: RepliableCommand, msg: string): Promise<void> {
  await i
    .reply({ content: msg, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } })
    .catch(() => {});
}
