import { describe, expect, test, mock } from "bun:test";
import { MessageFlags } from "discord.js";
import type { Guild } from "discord.js";
import {
  buildWelcomeRoles,
  buildWelcomePayload,
  resolveRoleName,
  reconcileWelcomeMessage,
} from "../../../src/integrations/onboarding/welcome-message.ts";
import { encodePick } from "../../../src/integrations/onboarding/custom-id.ts";
import { ACCENT, MAX_ROLE_SECTIONS } from "../../../src/integrations/onboarding/ui.ts";
import { textOf, buttonsOf } from "./v2-util.ts";
import type { guildConfig as GuildConfig } from "../../../src/config/guild.ts";

type Cfg = typeof GuildConfig;

const ROLE_1 = "200000000000000001";
const ROLE_2 = "200000000000000002";
const ROLE_3 = "200000000000000003";

const ROLE_NAMES: Record<string, string> = {
  [ROLE_1]: "Member",
  [ROLE_2]: "Contributor",
  [ROLE_3]: "Moderator",
};

// Inline Guild mock: roles.cache.get(id) -> { name, members.size } and members.fetch (reconcile
// calls it to warm the cache before counting).
function fakeGuild(
  names: Record<string, string> = ROLE_NAMES,
  counts: Record<string, number> = {},
): Guild {
  return {
    members: { fetch: mock(async () => {}) },
    roles: {
      cache: {
        get: (id: string) => {
          const name = names[id];
          if (name === undefined) return undefined;
          return { name, members: { size: counts[id] ?? 0 } };
        },
      },
    },
  } as unknown as Guild;
}

const cfg = {
  welcomeChannelId: "100000000000000001",
  accessRequestsChannelId: "100000000000000002",
  guestRoleId: "100000000000000003",
  pickableRoleIds: [ROLE_1, ROLE_2, ROLE_3],
  roleMeta: { [ROLE_1]: { blurb: "Member blurb" }, [ROLE_2]: { blurb: "Contrib blurb" } },
  welcomeMessage: "Pick a role below.",
  reviewSla: "~12h",
} as unknown as Cfg;

describe("resolveRoleName", () => {
  test("returns the live role name when resolvable, raw id otherwise", () => {
    const g = fakeGuild();
    expect(resolveRoleName(g, ROLE_1)).toBe("Member");
    expect(resolveRoleName(g, "299999999999999999")).toBe("299999999999999999");
    expect(resolveRoleName(null, ROLE_1)).toBe(ROLE_1);
  });
});

describe("buildWelcomeRoles", () => {
  test("maps each pickable id to name + blurb (from roleMeta) + live member count", () => {
    const { roles, extraCount } = buildWelcomeRoles(fakeGuild(ROLE_NAMES, { [ROLE_1]: 88 }), cfg);
    expect(extraCount).toBe(0);
    expect(roles.length).toBe(3);
    expect(roles[0]).toMatchObject({ roleId: ROLE_1, name: "Member", blurb: "Member blurb", memberCount: 88 });
    expect(roles[2]).toMatchObject({ roleId: ROLE_3, name: "Moderator" });
    expect(roles[2]!.blurb).toBeUndefined(); // ROLE_3 has no roleMeta entry
  });

  test("truncates to MAX_ROLE_SECTIONS and reports the overflow", () => {
    const ids = Array.from({ length: MAX_ROLE_SECTIONS + 2 }, (_, n) => `30000000000000${(100 + n).toString()}`);
    const big = { ...cfg, pickableRoleIds: ids } as unknown as Cfg;
    const { roles, extraCount } = buildWelcomeRoles(fakeGuild({}), big);
    expect(roles.length).toBe(MAX_ROLE_SECTIONS);
    expect(extraCount).toBe(2);
  });
});

describe("buildWelcomePayload", () => {
  test("blurple V2 container: intro + a Request button per role + SLA footer", () => {
    const c = buildWelcomePayload(fakeGuild(ROLE_NAMES, { [ROLE_1]: 88 }), cfg).toJSON();
    expect(c.accent_color).toBe(ACCENT.info);
    const txt = textOf(c);
    expect(txt).toContain("Pick a role below.");
    expect(txt).toContain("**Member**");
    expect(txt).toContain("Member blurb");
    expect(txt).toContain("· 88 members");
    expect(txt).toContain("within ~12h");

    const ids = buttonsOf(c).map((b) => b.custom_id);
    expect(ids).toEqual(cfg.pickableRoleIds.map((id) => encodePick(id)));
  });

  test("renders a '+N more' note + caps buttons at MAX_ROLE_SECTIONS past the limit", () => {
    const ids = Array.from({ length: MAX_ROLE_SECTIONS + 3 }, (_, n) => `30000000000000${(200 + n).toString()}`);
    const big = { ...cfg, pickableRoleIds: ids } as unknown as Cfg;
    const c = buildWelcomePayload(fakeGuild({}), big).toJSON();
    expect(buttonsOf(c).length).toBe(MAX_ROLE_SECTIONS);
    expect(textOf(c)).toContain("…and 3 more — ask an admin");
  });
});

// --- inline Discord mocks for reconcileWelcomeMessage ---

function textChannel(over: Record<string, unknown> = {}): any {
  return {
    guild: fakeGuild(),
    isTextBased: () => true,
    isSendable: () => true,
    messages: { fetch: mock(async () => collectionLike([])) },
    send: mock(async () => ({ pin: mock(async () => {}) })),
    ...over,
  };
}

function collectionLike(items: any[]): any {
  return { find: (pred: (v: any) => boolean) => items.find(pred) };
}

function fakeClient(channel: any): any {
  return {
    channels: { fetch: mock(async () => channel) },
    user: { id: "BOT_ID" },
    isReady: () => true,
  };
}

// Bot message whose pick button is a Section ACCESSORY (new layout): Container -> Section ->
// accessory button. Exercises the detector's `.accessory` branch.
function botMsgSectionAccessory(over: Record<string, unknown> = {}): any {
  return {
    author: { id: "BOT_ID" },
    components: [{ components: [{ accessory: { customId: encodePick(ROLE_1) } }] }],
    edit: mock(async () => {}),
    delete: mock(async () => {}),
    ...over,
  };
}

// Bot message whose pick button is in an ActionRow (the PREVIOUS V2 layout) — must still be
// detected so the Section migration edits it in place.
function botMsgActionRow(over: Record<string, unknown> = {}): any {
  return {
    author: { id: "BOT_ID" },
    components: [{ components: [{ components: [{ customId: encodePick(ROLE_1) }] }] }],
    edit: mock(async () => {}),
    delete: mock(async () => {}),
    ...over,
  };
}

describe("reconcileWelcomeMessage", () => {
  test("edits an existing V2 welcome message in place (Section-accessory layout detected)", async () => {
    const existing = botMsgSectionAccessory({ flags: { has: () => true } });
    const channel = textChannel({ messages: { fetch: mock(async () => collectionLike([existing])) } });
    const client = fakeClient(channel);

    await reconcileWelcomeMessage(client, cfg);

    expect(existing.edit).toHaveBeenCalledTimes(1);
    const editArg = existing.edit.mock.calls[0][0];
    expect(editArg.flags).toBeUndefined(); // immutable V2 flag not re-sent on edit
    const editc = (editArg.components[0] as { toJSON: () => any }).toJSON();
    expect(buttonsOf(editc).length).toBe(cfg.pickableRoleIds.length);
    expect(textOf(editc)).toContain("**Member**");
    expect(existing.delete).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });

  test("also detects the previous ActionRow V2 layout (edits in place)", async () => {
    const existing = botMsgActionRow({ flags: { has: () => true } });
    const channel = textChannel({ messages: { fetch: mock(async () => collectionLike([existing])) } });
    await reconcileWelcomeMessage(fakeClient(channel), cfg);
    expect(existing.edit).toHaveBeenCalledTimes(1);
  });

  test("replaces a legacy (non-V2) message: delete + send (V2 flag) + pin", async () => {
    const existing = botMsgSectionAccessory({ flags: { has: () => false } });
    const pin = mock(async () => {});
    const channel = textChannel({
      messages: { fetch: mock(async () => collectionLike([existing])) },
      send: mock(async () => ({ pin })),
    });
    await reconcileWelcomeMessage(fakeClient(channel), cfg);

    expect(existing.delete).toHaveBeenCalledTimes(1);
    expect(existing.edit).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send.mock.calls[0][0].flags).toBe(MessageFlags.IsComponentsV2);
    expect(pin).toHaveBeenCalledTimes(1);
  });

  test("sends + pins (V2 flag) when no prior message exists", async () => {
    const pin = mock(async () => {});
    const channel = textChannel({
      messages: { fetch: mock(async () => collectionLike([])) },
      send: mock(async () => ({ pin })),
    });
    await reconcileWelcomeMessage(fakeClient(channel), cfg);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send.mock.calls[0][0].flags).toBe(MessageFlags.IsComponentsV2);
    expect(pin).toHaveBeenCalledTimes(1);
  });

  test("ignores another bot's message and a buttonless message (sends fresh)", async () => {
    const notOurs = botMsgSectionAccessory({ author: { id: "OTHER" } });
    const noButton = { author: { id: "BOT_ID" }, components: [{ components: [] }], edit: mock(async () => {}) };
    const channel = textChannel({
      messages: { fetch: mock(async () => collectionLike([notOurs, noButton])) },
      send: mock(async () => ({ pin: mock(async () => {}) })),
    });
    await reconcileWelcomeMessage(fakeClient(channel), cfg);
    expect(notOurs.edit).not.toHaveBeenCalled();
    expect(noButton.edit).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  test("does not throw when the channel is missing (logs + returns)", async () => {
    const client = { channels: { fetch: mock(async () => null) }, user: { id: "BOT_ID" } } as any;
    await expect(reconcileWelcomeMessage(client, cfg)).resolves.toBeUndefined();
  });

  test("does not throw when a Discord call rejects (gateway catch)", async () => {
    const channel = textChannel({ messages: { fetch: mock(async () => { throw new Error("boom"); }) } });
    await expect(reconcileWelcomeMessage(fakeClient(channel), cfg)).resolves.toBeUndefined();
  });

  test("ignores a non-text channel", async () => {
    const channel = { isTextBased: () => false } as any;
    await expect(reconcileWelcomeMessage(fakeClient(channel), cfg)).resolves.toBeUndefined();
  });
});
