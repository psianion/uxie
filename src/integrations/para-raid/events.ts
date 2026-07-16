// para-raid webhook event handling — the business logic side of the receiver (receiver.ts is
// pure transport: HMAC + dedup + dispatch). One function per event type; anything unrecognized
// (esp. the high-volume tool_call) falls through to a log line only — the repo's Logger has no
// "debug" level (lib/log.ts), so that's the closest equivalent: visible in logs, silent in
// Discord.
import { AttachmentBuilder, ChannelType, DiscordAPIError, RESTJSONErrorCodes, type Client } from "discord.js";
import type { AnyThreadChannel } from "discord.js";
import type { ParaRaidClient, Session } from "./client.ts";
import type { SessionCache } from "./sessions.ts";
import type { ParaRaidEvent } from "./receiver.ts";
import { log } from "../../lib/log.ts";

export interface EventDeps {
  client: Client;
  api: ParaRaidClient;
  sessions: SessionCache;
  // U6: channel for nightly librarian session threads (LIBRARIAN_CHANNEL_ID). Absent = the
  // librarian feature is off and librarian:* events are logged + dropped.
  librarianChannelId?: string;
}

// A7 reuses this exact wording for the relay's 503 mapping — one string, one source of truth.
export const PAUSED_HINT = "daemon is paused — run `para-raid resume` on the host";

const REPLY_INLINE_MAX = 2000; // Discord's message content limit
const REPLY_PREVIEW_CHARS = 300;

export function createEventHandler(deps: EventDeps): (evt: ParaRaidEvent) => Promise<void> {
  return (evt) => handleEvent(evt, deps);
}

async function handleEvent(evt: ParaRaidEvent, deps: EventDeps): Promise<void> {
  switch (evt.eventType) {
    case "session_live":
      await notifySession(evt, deps, "session live");
      return;
    case "turn_replied":
      await handleTurnReplied(evt, deps);
      return;
    case "turn_failed":
      await handleTurnFailed(evt, deps);
      return;
    case "session_dead": {
      const reason = typeof evt.body.reason === "string" ? evt.body.reason : "unknown";
      await notifySession(evt, deps, `session dead (${reason})`);
      return;
    }
    case "session_recover_candidate":
      await handleRecoverCandidate(evt, deps);
      return;
    case "paused":
    case "resumed":
      await handlePauseResume(evt, deps);
      return;
    default:
      log.info("para-raid event", { eventType: evt.eventType, sessionId: evt.sessionId });
      return;
  }
}

// A1: send-turn.ts:107 does `reply ?? ""` — an empty/absent reply would 400 on Discord (empty
// message content isn't allowed). Exported so the receiver test covers it directly.
export function formatReply(reply: unknown): string {
  return typeof reply === "string" && reply.length > 0 ? reply : "(no textual output)";
}

async function handleTurnReplied(evt: ParaRaidEvent, deps: EventDeps): Promise<void> {
  const threadId = await threadIdFor(evt, deps);
  if (!threadId) return;
  const reply = formatReply(evt.body.reply);

  if (reply.length <= REPLY_INLINE_MAX) {
    await postText(deps, threadId, evt.sessionId, reply);
    return;
  }
  const preview = `${reply.slice(0, REPLY_PREVIEW_CHARS)}… (full reply attached)`;
  const attachment = new AttachmentBuilder(Buffer.from(reply, "utf-8"), { name: "reply.md" });
  await postToThread(deps, threadId, evt.sessionId, (ch) => ch.send({ content: preview, files: [attachment] }));
}

async function handleTurnFailed(evt: ParaRaidEvent, deps: EventDeps): Promise<void> {
  const threadId = await threadIdFor(evt, deps);
  if (!threadId) return;
  const error = typeof evt.body.error === "string" ? evt.body.error : "unknown error";
  // A9: sessions/turn-runner.ts's Stop-timeout message is "Stop timeout after <ms>ms for
  // session <id>" — that specific failure means the pane may still be working, not that the
  // turn is lost, so it gets its own reassuring wording instead of a bare error dump.
  const message = /stop timeout/i.test(error)
    ? "turn exceeded the daemon's turn_timeout_ms; the pane may still finish — check /raid status or send another message"
    : `turn failed: ${error}`;
  await postText(deps, threadId, evt.sessionId, message);
}

// A6, CRITICAL: without this, every para-raid restart (including every update-para-raid.sh
// run) kills all sessions once the 10-min recovery grace window lapses — open_session can't
// reclaim them (a fresh thread id never matches the old adapter_ref). resume-session.ts always
// answers 200 with status "live" or "dead"; a thrown/network error here is genuinely transient
// and propagates so the webhook gets redelivered (another shot at reaching the daemon).
async function handleRecoverCandidate(evt: ParaRaidEvent, deps: EventDeps): Promise<void> {
  if (!evt.sessionId) return;
  const res = await deps.api.resumeSession({ session_id: evt.sessionId });
  const threadId = await threadIdFor(evt, deps);
  if (!threadId) return;
  const recovered = res.status === 200 && res.body.status === "live";
  const message = recovered
    ? "session recovered after restart"
    : `session recovery failed (${res.body.error ?? res.status}) — it is now dead`;
  await postText(deps, threadId, evt.sessionId, message);
}

// A8: session_id is null on paused/resumed, so there's nothing to resolve — fan out best-effort
// to every currently-live thread. para-raid auto-pauses on Claude usage-limit hits and RAM
// pressure; without this a paused daemon just looks like a dead bot.
async function handlePauseResume(evt: ParaRaidEvent, deps: EventDeps): Promise<void> {
  log.warn(`para-raid daemon ${evt.eventType}`);
  const message = evt.eventType === "paused" ? PAUSED_HINT : "para-raid daemon resumed — sessions are live again";
  const threadIds = await deps.sessions.liveThreadIds();
  await Promise.all(
    threadIds.map((threadId) =>
      postText(deps, threadId, null, message).catch((err: unknown) => {
        log.warn("para-raid pause/resume note failed", { threadId, err });
      }),
    ),
  );
}

async function notifySession(evt: ParaRaidEvent, deps: EventDeps, message: string): Promise<void> {
  const threadId = await threadIdFor(evt, deps);
  if (!threadId) return;
  await postText(deps, threadId, evt.sessionId, message);
}

const LIBRARIAN_REF = /^librarian:/;

async function threadIdFor(evt: ParaRaidEvent, deps: EventDeps): Promise<string | undefined> {
  if (!evt.sessionId) return undefined;
  const session = await deps.sessions.resolveBySession(evt.sessionId);
  if (!session) {
    log.warn("para-raid event for unknown session", { eventType: evt.eventType, sessionId: evt.sessionId });
    return undefined;
  }
  const threadId = deps.sessions.threadFor(session);
  // U6: an unregistered librarian session — its adapter_ref ("librarian:<utc-date>", set by the
  // nightly CLI open-session) is not a thread id, so resolve-or-create its thread first. Once
  // registered, threadFor returns a real thread id and this branch never fires again.
  if (LIBRARIAN_REF.test(threadId)) return resolveLibrarianThread(session, deps);
  return threadId;
}

// U6: find-or-create the librarian session's thread in LIBRARIAN_CHANNEL_ID. Searching the
// channel's ACTIVE threads for one named exactly the adapter_ref first dedups across uxie
// restarts (the registration cache is in-memory); otherwise a public thread is created. The
// registration makes every subsequent event — and the relay — flow through the normal paths.
async function resolveLibrarianThread(session: Session, deps: EventDeps): Promise<string | undefined> {
  const channelId = deps.librarianChannelId;
  if (!channelId) {
    log.warn("para-raid librarian event dropped — LIBRARIAN_CHANNEL_ID not set", {
      sessionId: session.id,
      adapterRef: session.adapter_ref,
    });
    return undefined;
  }
  try {
    const channel = await deps.client.channels.fetch(channelId);
    // ponytail: GuildText only — the librarian channel is a plain text channel; widen if it
    // ever moves to announcements/forum.
    if (!channel || channel.type !== ChannelType.GuildText) {
      await deps.api.closeSession({ session_id: session.id }).catch(() => {});
      log.warn("para-raid librarian channel unavailable, session closed", { channelId, sessionId: session.id });
      return undefined;
    }
    const active = await channel.threads.fetchActive();
    const existing = active.threads.find((t) => t.name === session.adapter_ref);
    const thread = existing ?? (await channel.threads.create({ name: session.adapter_ref }));
    deps.sessions.registerThread(session.id, thread.id);
    return thread.id;
  } catch (err) {
    // Missing/no-access channel reaps the session and acks (same contract as postToThread, A2);
    // anything else propagates so the receiver 500s and para-raid redelivers.
    if (await closeIfPermanent(err, deps, session.id, channelId)) return undefined;
    throw err;
  }
}

async function postText(
  deps: EventDeps,
  threadId: string,
  sessionId: string | null,
  content: string,
): Promise<void> {
  await postToThread(deps, threadId, sessionId, (ch) => ch.send(content));
}

// Thread posting helper (D1/D3). Unarchives once before sending (a session thread often sits
// idle past Discord's auto-archive window); a permanent Discord failure (A2 — Unknown Channel
// 10003 / Missing Access 50001, i.e. the thread got deleted or we lost access) reaps the
// orphaned session and resolves normally so the caller acks 200 instead of retrying forever.
// Anything else propagates so the caller's caller (the receiver) returns 500 and para-raid
// retries.
async function postToThread(
  deps: EventDeps,
  threadId: string,
  sessionId: string | null,
  send: (channel: AnyThreadChannel) => Promise<unknown>,
): Promise<void> {
  let channel;
  try {
    channel = await deps.client.channels.fetch(threadId);
  } catch (err) {
    if (await closeIfPermanent(err, deps, sessionId, threadId)) return;
    throw err;
  }
  if (!channel || !channel.isThread()) {
    // Not found, or no longer a postable thread — same outcome as Unknown Channel above.
    if (sessionId) await deps.api.closeSession({ session_id: sessionId }).catch(() => {});
    log.warn("para-raid thread unavailable, session closed", { threadId, sessionId });
    return;
  }

  if (channel.archived) await channel.setArchived(false);

  try {
    await send(channel);
  } catch (err) {
    if (await closeIfPermanent(err, deps, sessionId, threadId)) return;
    throw err;
  }
}

async function closeIfPermanent(
  err: unknown,
  deps: EventDeps,
  sessionId: string | null,
  threadId: string,
): Promise<boolean> {
  const permanent =
    err instanceof DiscordAPIError &&
    (err.code === RESTJSONErrorCodes.UnknownChannel || err.code === RESTJSONErrorCodes.MissingAccess);
  if (!permanent) return false;
  if (sessionId) await deps.api.closeSession({ session_id: sessionId }).catch(() => {});
  log.warn("para-raid thread permanently unreachable, session closed", { threadId, sessionId, code: (err as DiscordAPIError).code });
  return true;
}
