import { describe, expect, test } from "bun:test";
import { ButtonStyle } from "discord.js";
import {
  ACCENT,
  buildWelcomeContainer,
  buildAccessRequestContainer,
  buildDecisionContainer,
  buildDmContainer,
} from "../../../src/integrations/onboarding/ui.ts";
import { encodeApproval, encodePick } from "../../../src/integrations/onboarding/custom-id.ts";
import { textOf, buttonsOf, thumbUrls } from "./v2-util.ts";

const USER = "400000000000000009";
const ROLE = "200000000000000001";
const ROLE2 = "200000000000000002";
const REVIEWER = "500000000000000001";
const AVATAR = "https://cdn.discordapp.com/avatars/abc.png";
const ICON = "https://cdn.discordapp.com/icons/guild.png";

describe("buildWelcomeContainer", () => {
  test("blurple, 🎭 header, intro, a Section per role (name·count·blurb) with a Request button accessory", () => {
    const c = buildWelcomeContainer({
      intro: "Pick a role below.",
      roles: [
        { roleId: ROLE, name: "Gamer", blurb: "Game nights & #lfg", memberCount: 88 },
        { roleId: ROLE2, name: "Dev", blurb: "#dev-chat + pings", memberCount: 1 },
      ],
      footer: "An admin reviews every request · usually within ~24h.",
    }).toJSON();

    expect(c.accent_color).toBe(ACCENT.info);
    const txt = textOf(c);
    expect(txt).toContain("🎭");
    expect(txt).toContain("Request a Role");
    expect(txt).toContain("Pick a role below.");
    expect(txt).toContain("**Gamer**");
    expect(txt).toContain("· 88 members");
    expect(txt).toContain("Game nights & #lfg");
    expect(txt).toContain("· 1 member"); // singular
    expect(txt).toContain("within ~24h");

    const btns = buttonsOf(c);
    expect(btns.length).toBe(2); // one Request accessory per role
    const ids = btns.map((b) => b.custom_id);
    expect(ids).toContain(encodePick(ROLE));
    expect(ids).toContain(encodePick(ROLE2));
    for (const b of btns) {
      expect(b.label).toBe("Request");
      expect(b.style).toBe(ButtonStyle.Secondary);
    }

    // structural: the Request buttons are Section ACCESSORIES, not an ActionRow — guard against
    // an accidental revert to the flat-row layout.
    const sections = (c.components as any[]).filter((x) => x.accessory);
    expect(sections.length).toBe(2);
    expect(sections.map((s: any) => s.accessory.custom_id)).toEqual([
      encodePick(ROLE),
      encodePick(ROLE2),
    ]);
  });

  test("no blurb / no count -> generic blurb line, no count text", () => {
    const c = buildWelcomeContainer({
      intro: "x",
      roles: [{ roleId: ROLE, name: "Gamer" }],
    }).toJSON();
    const txt = textOf(c);
    expect(txt).toContain("Request access — an admin reviews it.");
    expect(txt).not.toContain("members");
  });

  test("extraCount renders a '+N more' overflow note", () => {
    const c = buildWelcomeContainer({
      intro: "x",
      roles: [{ roleId: ROLE, name: "Gamer" }],
      extraCount: 3,
    }).toJSON();
    expect(textOf(c)).toContain("…and 3 more — ask an admin");
  });
});

describe("buildAccessRequestContainer", () => {
  test("blurple, dossier (mentions, account age, Status), avatar thumbnail, enabled Approve/Deny", () => {
    const c = buildAccessRequestContainer({
      userId: USER,
      roleId: ROLE,
      roleName: "Gamer",
      avatarUrl: AVATAR,
      createdAtSec: 1_700_000_000,
      atSec: 1_700_000_500,
    }).toJSON();

    expect(c.accent_color).toBe(ACCENT.info);
    const txt = textOf(c);
    expect(txt).toContain("Access Request");
    expect(txt).toContain(`<@${USER}>`);
    expect(txt).toContain(`<@&${ROLE}>`);
    expect(txt).toContain("Gamer");
    expect(txt).toContain("**Account created** <t:1700000000:R>");
    expect(txt).toContain("**Status** Awaiting your review");
    expect(txt).toContain("<t:1700000500:R>"); // requested-at footer

    expect(thumbUrls(c)).toContain(AVATAR); // avatar thumbnail accessory

    const btns = buttonsOf(c);
    const approve = btns.find((b) => b.custom_id === encodeApproval("approve", USER, ROLE));
    const deny = btns.find((b) => b.custom_id === encodeApproval("deny", USER, ROLE));
    expect(approve.style).toBe(ButtonStyle.Success);
    expect(deny.style).toBe(ButtonStyle.Danger);
    expect(approve.disabled).toBe(false);
    expect(deny.disabled).toBe(false);
  });

  test("no avatar -> no thumbnail (plain body); no createdAtSec -> no account-age line", () => {
    const c = buildAccessRequestContainer({ userId: USER, roleId: ROLE, roleName: "Gamer" }).toJSON();
    expect(thumbUrls(c).length).toBe(0);
    expect(textOf(c)).not.toContain("Account created");
    expect(textOf(c)).toContain("Awaiting review"); // static footer when no atSec
  });
});

describe("buildDecisionContainer", () => {
  test("approved: green, ✅ header, Status 'Approved by', DM-notified footer, DISABLED buttons + avatar", () => {
    const c = buildDecisionContainer({
      decision: "approved",
      userId: USER,
      roleId: ROLE,
      roleName: "Gamer",
      avatarUrl: AVATAR,
      createdAtSec: 1_700_000_000,
      reviewerId: REVIEWER,
    }).toJSON();

    expect(c.accent_color).toBe(ACCENT.approved);
    const txt = textOf(c);
    expect(txt).toContain("✅");
    expect(txt).toContain("Approved — Gamer");
    expect(txt).toContain(`**Status** Approved by <@${REVIEWER}>`);
    expect(txt).toContain("notified by DM");
    expect(thumbUrls(c)).toContain(AVATAR);

    const btns = buttonsOf(c);
    expect(btns.length).toBe(2);
    for (const b of btns) expect(b.disabled).toBe(true);
    const ids = btns.map((b) => b.custom_id);
    expect(ids).toContain(encodeApproval("approve", USER, ROLE));
    expect(ids).toContain(encodeApproval("deny", USER, ROLE));
  });

  test("approved + dmFailed: footer notes the DM failure", () => {
    const c = buildDecisionContainer({
      decision: "approved", userId: USER, roleId: ROLE, roleName: "Gamer", reviewerId: REVIEWER, dmFailed: true,
    }).toJSON();
    expect(textOf(c)).toContain("Could not DM the member");
  });

  test("denied: red, ⛔ 'Request Declined', Status 'Declined by'", () => {
    const c = buildDecisionContainer({
      decision: "denied", userId: USER, roleId: ROLE, roleName: "Gamer", reviewerId: REVIEWER,
    }).toJSON();
    expect(c.accent_color).toBe(ACCENT.denied);
    const txt = textOf(c);
    expect(txt).toContain("⛔");
    expect(txt).toContain("Request Declined");
    expect(txt).toContain(`**Status** Declined by <@${REVIEWER}>`);
  });

  test("member_left: grey, ⚠️ 'Member Left', footer 'no longer in the server', disabled", () => {
    const c = buildDecisionContainer({
      decision: "member_left", userId: USER, roleId: ROLE, roleName: "Gamer",
    }).toJSON();
    expect(c.accent_color).toBe(ACCENT.left);
    const txt = textOf(c);
    expect(txt).toContain("Member Left");
    expect(txt).toContain(`<@${USER}> is no longer in the server`);
    const btns = buttonsOf(c);
    expect(btns.length).toBe(2);
    for (const b of btns) expect(b.disabled).toBe(true);
  });

  test("error: red, ⚠️ 'Couldn't assign', Status 'Grant failed', footer names the cause + hierarchy hint", () => {
    const c = buildDecisionContainer({
      decision: "error", userId: USER, roleId: ROLE, roleName: "Gamer", reviewerId: REVIEWER,
      failureReason: "Missing permissions",
    }).toJSON();
    expect(c.accent_color).toBe(ACCENT.denied);
    const txt = textOf(c);
    expect(txt).toContain("Couldn't assign Gamer");
    expect(txt).toContain("**Status** Grant failed");
    expect(txt).toContain("Missing permissions");
    expect(txt).toContain("the bot's role is above");
    const ebtns = buttonsOf(c);
    expect(ebtns.length).toBe(2);
    for (const b of ebtns) expect(b.disabled).toBe(true);
  });
});

describe("buildDmContainer", () => {
  test("approved: green, 'You're in', role+guild+jump+pick-again channels, guild thumbnail, no buttons", () => {
    const c = buildDmContainer({
      decision: "approved",
      roleName: "Gamer",
      guildName: "My Server",
      guildIconUrl: ICON,
      jumpChannelId: "900000000000000001",
      welcomeChannelId: "900000000000000002",
    }).toJSON();
    expect(c.accent_color).toBe(ACCENT.approved);
    const txt = textOf(c);
    expect(txt).toContain("You're in — Gamer");
    expect(txt).toContain("**Gamer**");
    expect(txt).toContain("**My Server**");
    expect(txt).toContain("<#900000000000000001>"); // jump channel
    expect(txt).toContain("<#900000000000000002>"); // pick-again channel
    expect(thumbUrls(c)).toContain(ICON);
    expect(buttonsOf(c).length).toBe(0);
  });

  test("denied: red, 'Request Declined', re-request channel, no buttons; no icon -> plain body", () => {
    const c = buildDmContainer({
      decision: "denied", roleName: "Gamer", guildName: "My Server", welcomeChannelId: "900000000000000002",
    }).toJSON();
    expect(c.accent_color).toBe(ACCENT.denied);
    const txt = textOf(c);
    expect(txt).toContain("Request Declined");
    expect(txt).toContain("wasn't approved");
    expect(txt).toContain("<#900000000000000002>");
    expect(thumbUrls(c).length).toBe(0);
    expect(buttonsOf(c).length).toBe(0);
  });
});
