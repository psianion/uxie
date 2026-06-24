import { describe, expect, test, mock } from "bun:test";
import { MessageFlags } from "discord.js";
import { handleApprovalButton } from "../../../src/integrations/onboarding/approval-handler.ts";
import { encodeApproval } from "../../../src/integrations/onboarding/custom-id.ts";
import { container, textOf, buttonsOf, thumbUrls, isV2 } from "./v2-util.ts";
import type { guildConfig as GuildConfig } from "../../../src/config/guild.ts";

type Cfg = typeof GuildConfig;

const OWNER_ID = "500000000000000001";
const TARGET_USER = "400000000000000009";
const TARGET_ROLE = "200000000000000001";
const GUEST_ROLE = "100000000000000003";
const WELCOME_CH = "100000000000000001";
const UNLOCK_CH = "900000000000000001";
const AVATAR = "https://cdn.discordapp.com/avatars/u.png";
const ICON = "https://cdn.discordapp.com/icons/g.png";

const cfg = {
  welcomeChannelId: WELCOME_CH,
  accessRequestsChannelId: "100000000000000002",
  guestRoleId: GUEST_ROLE,
  pickableRoleIds: [TARGET_ROLE],
  roleMeta: { [TARGET_ROLE]: { blurb: "x", unlockedChannelIds: [UNLOCK_CH] } },
  welcomeMessage: "Pick.",
  reviewSla: "~24h",
} as unknown as Cfg;

function fakeTargetMember(over: { sendRejects?: boolean; hasRole?: boolean; addRejects?: boolean } = {}): any {
  return {
    user: { displayAvatarURL: () => AVATAR, createdTimestamp: 1_700_000_000_000 },
    roles: {
      cache: { has: (_id: string) => over.hasRole === true },
      remove: mock(async () => {}),
      add: over.addRejects
        ? mock(async () => {
            const e: any = new Error("Missing Permissions");
            e.code = 50013;
            throw e;
          })
        : mock(async () => {}),
    },
    send: over.sendRejects
      ? mock(async () => { throw new Error("DM closed"); })
      : mock(async () => {}),
  };
}

function fakeButton(over: {
  clickerId?: string;
  action?: "approve" | "deny";
  member?: any;
  guildMissing?: boolean;
  messageId?: string;
} = {}): any {
  const action = over.action ?? "approve";
  const member = over.member === undefined ? fakeTargetMember() : over.member;
  const guild = over.guildMissing
    ? null
    : {
        name: "Test Guild",
        iconURL: () => ICON,
        members: { fetch: mock(async () => member) },
        roles: { cache: { get: (_id: string) => ({ name: "Member" }) } },
      };
  return {
    customId: encodeApproval(action, TARGET_USER, TARGET_ROLE),
    user: { id: over.clickerId ?? OWNER_ID },
    guild,
    message: { id: over.messageId ?? "MSG_ID" },
    reply: mock(async (_: unknown) => {}),
    deferUpdate: mock(async () => {}),
    editReply: mock(async (_: unknown) => {}),
    __member: member,
  };
}

describe("handleApprovalButton — owner gate", () => {
  test("non-owner -> ephemeral refusal, NO role change, NO defer/edit", async () => {
    const member = fakeTargetMember();
    const i = fakeButton({ clickerId: "999999999999999999", member });
    await handleApprovalButton(i, OWNER_ID, cfg);

    expect(i.reply).toHaveBeenCalledTimes(1);
    expect(i.reply.mock.calls[0][0].flags).toBe(MessageFlags.Ephemeral);
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(i.deferUpdate).not.toHaveBeenCalled();
    expect(i.editReply).not.toHaveBeenCalled();
  });
});

describe("handleApprovalButton — approve", () => {
  test("grants role, DMs (V2, jump channel), edits to a green Approved container w/ dossier", async () => {
    const member = fakeTargetMember();
    const i = fakeButton({ action: "approve", member });
    await handleApprovalButton(i, OWNER_ID, cfg);

    expect(member.roles.remove).toHaveBeenCalledWith(GUEST_ROLE);
    expect(member.roles.add).toHaveBeenCalledWith(TARGET_ROLE);

    // DM: V2 container with the grant + a next-step channel
    expect(member.send).toHaveBeenCalledTimes(1);
    const dm = member.send.mock.calls[0][0];
    expect(isV2(dm.flags)).toBe(true);
    const dmTxt = textOf(container(dm));
    expect(dmTxt).toContain("You're in — Member");
    expect(dmTxt).toContain(`<#${UNLOCK_CH}>`); // jump channel from roleMeta
    expect(dmTxt).toContain(`<#${WELCOME_CH}>`); // pick-again channel

    expect(i.deferUpdate).toHaveBeenCalledTimes(1);
    expect(i.editReply).toHaveBeenCalledTimes(1);
    const arg = i.editReply.mock.calls[0][0];
    expect(isV2(arg.flags)).toBe(true);
    expect(arg.allowedMentions).toEqual({ parse: [] });

    const c = container(arg);
    const txt = textOf(c);
    expect(txt).toContain("Approved — Member");
    expect(txt).toContain(`**Status** Approved by <@${OWNER_ID}>`);
    expect(txt).toContain("Account created"); // dossier mirrored onto the decision card
    expect(thumbUrls(c)).toContain(AVATAR);

    const btns = buttonsOf(c);
    expect(btns.length).toBe(2);
    for (const b of btns) expect(b.disabled).toBe(true);
  });

  test("already-has-role: skips the role swap but still DMs + renders Approved", async () => {
    const member = fakeTargetMember({ hasRole: true });
    const i = fakeButton({ action: "approve", member });
    await handleApprovalButton(i, OWNER_ID, cfg);

    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(member.send).toHaveBeenCalledTimes(1);
    expect(textOf(container(i.editReply.mock.calls[0][0]))).toContain("Approved — Member");
  });

  test("grant failure (50013) -> red error card naming the cause, NO DM", async () => {
    const member = fakeTargetMember({ addRejects: true });
    const i = fakeButton({ action: "approve", member });
    await handleApprovalButton(i, OWNER_ID, cfg);

    expect(member.send).not.toHaveBeenCalled(); // returns before the DM
    expect(i.editReply).toHaveBeenCalledTimes(1);
    const txt = textOf(container(i.editReply.mock.calls[0][0]));
    expect(txt).toContain("Couldn't assign Member");
    expect(txt).toContain("Missing permissions");
    const ebtns = buttonsOf(container(i.editReply.mock.calls[0][0]));
    expect(ebtns.length).toBe(2);
    for (const b of ebtns) expect(b.disabled).toBe(true);
  });
});

describe("handleApprovalButton — deny", () => {
  test("no role change, DMs the denial, edits to a red Declined container", async () => {
    const member = fakeTargetMember();
    const i = fakeButton({ action: "deny", member });
    await handleApprovalButton(i, OWNER_ID, cfg);

    expect(member.roles.add).not.toHaveBeenCalled();
    expect(member.send).toHaveBeenCalledTimes(1);
    expect(textOf(container(member.send.mock.calls[0][0]))).toContain("Request Declined");

    const c = container(i.editReply.mock.calls[0][0]);
    const txt = textOf(c);
    expect(txt).toContain("Request Declined");
    expect(txt).toContain(`**Status** Declined by <@${OWNER_ID}>`);
    const btns = buttonsOf(c);
    expect(btns.length).toBe(2);
    for (const b of btns) expect(b.disabled).toBe(true);
  });
});

describe("handleApprovalButton — DM failure", () => {
  test("approve still grants the role AND the card notes the DM failure", async () => {
    const member = fakeTargetMember({ sendRejects: true });
    const i = fakeButton({ action: "approve", member });
    await handleApprovalButton(i, OWNER_ID, cfg);

    expect(member.roles.add).toHaveBeenCalledWith(TARGET_ROLE);
    expect(i.editReply).toHaveBeenCalledTimes(1);
    expect(textOf(container(i.editReply.mock.calls[0][0]))).toContain("Could not DM the member");
  });
});

describe("handleApprovalButton — member left", () => {
  test("members.fetch null -> grey Member Left container, disabled, no role change", async () => {
    const i = fakeButton({ member: null });
    await handleApprovalButton(i, OWNER_ID, cfg);

    expect(i.deferUpdate).toHaveBeenCalledTimes(1);
    const c = container(i.editReply.mock.calls[0][0]);
    expect(textOf(c)).toContain("Member Left");
    const btns = buttonsOf(c);
    expect(btns.length).toBe(2);
    for (const b of btns) expect(b.disabled).toBe(true);
  });

  test("members.fetch rejecting is treated as member-left (no throw)", async () => {
    const i = fakeButton();
    i.guild.members.fetch = mock(async () => { throw new Error("Unknown Member"); });
    await expect(handleApprovalButton(i, OWNER_ID, cfg)).resolves.toBeUndefined();
    expect(textOf(container(i.editReply.mock.calls[0][0]))).toContain("Member Left");
  });
});

describe("handleApprovalButton — concurrency lock", () => {
  test("a double-click on the same card grants + DMs exactly once; the second is dropped", async () => {
    const member = fakeTargetMember();
    const i1 = fakeButton({ member, messageId: "SAME" });
    const i2 = fakeButton({ member, messageId: "SAME" });

    await Promise.all([
      handleApprovalButton(i1, OWNER_ID, cfg),
      handleApprovalButton(i2, OWNER_ID, cfg),
    ]);

    // exactly one grant + one DM across both clicks
    expect(member.roles.add).toHaveBeenCalledTimes(1);
    expect(member.send).toHaveBeenCalledTimes(1);
    // the dropped click was acked (deferUpdate) but rendered no decision
    expect(i2.deferUpdate).toHaveBeenCalledTimes(1);
    expect(i2.editReply).not.toHaveBeenCalled();
    expect(i1.editReply).toHaveBeenCalledTimes(1);
  });
});
