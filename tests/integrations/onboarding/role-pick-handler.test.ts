import { beforeEach, describe, expect, test, mock } from "bun:test";
import { MessageFlags } from "discord.js";
import {
  handleRolePick,
  __clearRolePickThrottle,
} from "../../../src/integrations/onboarding/role-pick-handler.ts";
import { encodePick, encodeApproval } from "../../../src/integrations/onboarding/custom-id.ts";
import { ConfigError } from "../../../src/lib/errors.ts";
import { container, textOf, buttonsOf, thumbUrls, isV2 } from "./v2-util.ts";
import type { guildConfig as GuildConfig } from "../../../src/config/guild.ts";

type Cfg = typeof GuildConfig;

const ROLE_MEMBER = "200000000000000001";
const ROLE_CONTRIB = "200000000000000002";
const USER_ID = "400000000000000009";
const AVATAR = "https://cdn.discordapp.com/avatars/u.png";

const ROLE_NAMES: Record<string, string> = {
  [ROLE_MEMBER]: "Member",
  [ROLE_CONTRIB]: "Contributor",
};

const cfg = {
  welcomeChannelId: "100000000000000001",
  accessRequestsChannelId: "100000000000000002",
  guestRoleId: "100000000000000003",
  pickableRoleIds: [ROLE_MEMBER, ROLE_CONTRIB],
  welcomeMessage: "Pick a role.",
  reviewSla: "~24h",
} as unknown as Cfg;

function fakeAccessChannel(): any {
  return { isSendable: () => true, send: mock(async () => {}) };
}

function fakeGuild(names: Record<string, string> = ROLE_NAMES): any {
  return {
    roles: {
      cache: {
        get: (id: string) => {
          const name = names[id];
          return name === undefined ? undefined : { name };
        },
      },
    },
  };
}

function fakeButton(over: {
  customId?: string;
  roleCacheHas?: boolean | null;
  channel?: any;
  guild?: any;
  userId?: string;
} = {}): any {
  const channel = over.channel ?? fakeAccessChannel();
  const member =
    over.roleCacheHas === null
      ? {}
      : { roles: { cache: { has: (_id: string) => over.roleCacheHas === true } } };
  return {
    customId: over.customId ?? encodePick(ROLE_MEMBER),
    user: {
      id: over.userId ?? USER_ID,
      displayAvatarURL: () => AVATAR,
      createdTimestamp: 1_700_000_000_000,
    },
    member,
    guild: over.guild === undefined ? fakeGuild() : over.guild,
    reply: mock(async (_: unknown) => {}),
    deferReply: mock(async (_: unknown) => {}),
    editReply: mock(async (_: unknown) => {}),
    client: { channels: { fetch: mock(async () => channel) } },
    __channel: channel,
  };
}

// The throttle is module-level state that persists across cases — reset it before every test so
// the existing same-user happy-path tests stay independent.
beforeEach(() => __clearRolePickThrottle());

describe("handleRolePick", () => {
  test("happy path: ephemeral ack (SLA) + V2 request container (dossier + avatar, pings suppressed) + Approve/Deny", async () => {
    const i = fakeButton();
    await handleRolePick(i, cfg);

    expect(i.deferReply).toHaveBeenCalledTimes(1);
    expect(i.deferReply.mock.calls[0][0].flags).toBe(MessageFlags.Ephemeral);
    expect(i.editReply).toHaveBeenCalledTimes(1);
    const ack = i.editReply.mock.calls[0][0].content;
    expect(ack).toContain("Member");
    expect(ack).toContain("~24h"); // SLA threaded into the ack

    expect(i.__channel.send).toHaveBeenCalledTimes(1);
    const sent = i.__channel.send.mock.calls[0][0];
    expect(isV2(sent.flags)).toBe(true);
    expect(sent.allowedMentions).toEqual({ parse: [] });

    const c = container(sent);
    const txt = textOf(c);
    expect(txt).toContain(`<@&${ROLE_MEMBER}>`);
    expect(txt).toContain("Member");
    expect(txt).toContain("Account created"); // dossier age line
    expect(thumbUrls(c)).toContain(AVATAR); // requester avatar thumbnail

    const ids = buttonsOf(c).map((b) => b.custom_id);
    expect(ids).toContain(encodeApproval("approve", USER_ID, ROLE_MEMBER));
    expect(ids).toContain(encodeApproval("deny", USER_ID, ROLE_MEMBER));
  });

  test("falls back to raw id in the ack when the role is unresolved", async () => {
    const i = fakeButton({ guild: fakeGuild({}) });
    await handleRolePick(i, cfg);
    expect(i.editReply.mock.calls[0][0].content).toContain(ROLE_MEMBER);
  });

  test("unknown role -> ephemeral reject, NO access-requests post", async () => {
    const i = fakeButton({ customId: encodePick("299999999999999999") });
    await handleRolePick(i, cfg);
    expect(i.reply).toHaveBeenCalledTimes(1);
    const arg = i.reply.mock.calls[0][0];
    expect(arg.flags).toBe(MessageFlags.Ephemeral);
    expect(arg.content).toMatch(/out of date/i);
    expect(i.__channel.send).not.toHaveBeenCalled();
  });

  test("already-has-role -> ephemeral guard, NO access-requests post", async () => {
    const i = fakeButton({ roleCacheHas: true });
    await handleRolePick(i, cfg);
    expect(i.reply).toHaveBeenCalledTimes(1);
    const arg = i.reply.mock.calls[0][0];
    expect(arg.flags).toBe(MessageFlags.Ephemeral);
    expect(arg.content).toMatch(/already have/i);
    expect(i.__channel.send).not.toHaveBeenCalled();
  });

  test("partial member without roles.cache -> guard skipped, still posts request", async () => {
    const i = fakeButton({ roleCacheHas: null });
    await handleRolePick(i, cfg);
    expect(i.__channel.send).toHaveBeenCalledTimes(1);
  });

  test("missing access-requests channel -> throws ConfigError (bubbles to router)", async () => {
    const i = fakeButton({ channel: null });
    i.client.channels.fetch = mock(async () => null);
    await expect(handleRolePick(i, cfg)).rejects.toBeInstanceOf(ConfigError);
  });
});

// Deterministic injectable clock — avoids stubbing the global Date.now.
function mkClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

// UX-SEC-001: a guest who does not yet hold a pickable role never trips the already-has-role
// guard, so without a throttle they can flood #access-requests by re-clicking the persistent
// Request button. The handler stamps a per-user+role TTL before the first await and refuses a
// repeat within the window without deferring/fetching/posting a second card.
describe("handleRolePick — flood throttle (UX-SEC-001)", () => {
  const U = "400000000000000777";

  test("a repeat for the same user+role within the window is refused — no defer/fetch/second card", async () => {
    const channel = fakeAccessChannel();
    const clock = mkClock();

    const i1 = fakeButton({ userId: U, channel });
    await handleRolePick(i1, cfg, clock.now);
    expect(channel.send).toHaveBeenCalledTimes(1);

    clock.advance(1000); // still deep inside the 5-min default window
    const i2 = fakeButton({ userId: U, channel });
    await handleRolePick(i2, cfg, clock.now);

    expect(i2.deferReply).not.toHaveBeenCalled();
    expect(i2.client.channels.fetch).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledTimes(1); // no second card posted
    expect(i2.reply).toHaveBeenCalledTimes(1);
    expect(i2.reply.mock.calls[0][0].flags).toBe(MessageFlags.Ephemeral);
    expect(i2.reply.mock.calls[0][0].content).toMatch(/already requested/i);
  });

  test("a different role for the same user is NOT throttled (per-user+role key)", async () => {
    const channel = fakeAccessChannel();
    const clock = mkClock();
    await handleRolePick(fakeButton({ userId: U, customId: encodePick(ROLE_MEMBER), channel }), cfg, clock.now);
    await handleRolePick(fakeButton({ userId: U, customId: encodePick(ROLE_CONTRIB), channel }), cfg, clock.now);
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  test("a different user for the same role is NOT throttled", async () => {
    const channel = fakeAccessChannel();
    const clock = mkClock();
    await handleRolePick(fakeButton({ userId: U, channel }), cfg, clock.now);
    await handleRolePick(fakeButton({ userId: "400000000000000888", channel }), cfg, clock.now);
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  test("the same user+role sends again once the window elapses", async () => {
    const channel = fakeAccessChannel();
    const clock = mkClock();
    await handleRolePick(fakeButton({ userId: U, channel }), cfg, clock.now);
    clock.advance(5 * 60_000 + 1); // past the 5-min default
    await handleRolePick(fakeButton({ userId: U, channel }), cfg, clock.now);
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  test("respects a custom cfg.rolePickCooldownMs window", async () => {
    const channel = fakeAccessChannel();
    const clock = mkClock();
    const tinyCfg = { ...cfg, rolePickCooldownMs: 1000 } as unknown as Cfg;

    await handleRolePick(fakeButton({ userId: U, channel }), tinyCfg, clock.now);
    clock.advance(500); // within the 1s window -> refused
    await handleRolePick(fakeButton({ userId: U, channel }), tinyCfg, clock.now);
    expect(channel.send).toHaveBeenCalledTimes(1);

    clock.advance(600); // 1100ms total -> past the window -> sends again
    await handleRolePick(fakeButton({ userId: U, channel }), tinyCfg, clock.now);
    expect(channel.send).toHaveBeenCalledTimes(2);
  });
});
