// Pure Components V2 render kit for the onboarding flow. Maps onboarding primitives (ids,
// names, blurbs, avatar URLs, timestamps) to a ContainerBuilder. Mirrors the idioms of
// ../../lib/ui/status-container.ts, extended with Section accessories (a Request button beside
// each role on the picker; the requester's avatar Thumbnail on review cards).
//
// Pure and synchronous (no guild/client, no async) so every container is unit-testable via
// .toJSON() with no live Discord — the handler/welcome layer resolves names, counts, avatar
// URLs and ages and passes them in as args. The caller sends it with
//   { flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: { parse: [] } }
// — V2 messages carry NO `content`/`embeds`, and V2 TextDisplay mentions PING unless suppressed.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from "discord.js";
import { encodeApproval, encodePick } from "./custom-id.ts";

// Accent bar colors. Blurple = neutral/info; green/red = terminal outcomes; grey = the member
// left before review. Greens/reds match ../../lib/ui/status-container.ts for a consistent palette.
export const ACCENT = {
  info: 0x5865f2,
  approved: 0x57f287,
  denied: 0xed4245,
  left: 0x4f545c,
} as const;

// Section is ~3 components (section + text + accessory); with the ~40-component V2 budget and a
// header/intro/separators/footer, ~10 role sections is the safe ceiling. Callers truncate to this.
export const MAX_ROLE_SECTIONS = 10;

export type Decision = "approved" | "denied" | "member_left" | "error";

export interface WelcomeRole {
  roleId: string;
  name: string;
  blurb?: string;
  memberCount?: number;
}

function header(icon: string, title: string): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(`### ${icon}  ${title}`);
}

function text(content: string): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(content);
}

function divider(): SeparatorBuilder {
  return new SeparatorBuilder().setDivider(true);
}

// Identity block shared by the request card + its terminal decision state, so a request and its
// outcome read identically. Mentions render as styled pills; the caller suppresses pinging.
function identityBody(opts: {
  userId: string;
  roleId: string;
  roleName: string;
  createdAtSec?: number;
  statusText?: string;
}): string {
  const lines = [
    `**User** <@${opts.userId}>`,
    `**Requesting** <@&${opts.roleId}> (${opts.roleName})`,
  ];
  if (opts.createdAtSec !== undefined) {
    lines.push(`**Account created** <t:${opts.createdAtSec}:R>`);
  }
  if (opts.statusText) lines.push(`**Status** ${opts.statusText}`);
  return lines.join("\n");
}

// Add the identity body as a Section with the requester's avatar Thumbnail accessory, or — when
// no avatar URL is available (e.g. the member already left) — as a plain TextDisplay.
function addIdentity(container: ContainerBuilder, body: string, avatarUrl?: string): void {
  if (avatarUrl) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(text(body))
        .setThumbnailAccessory(
          new ThumbnailBuilder().setURL(avatarUrl).setDescription("requester avatar"),
        ),
    );
  } else {
    container.addTextDisplayComponents(text(body));
  }
}

// One Approve(Success)/Deny(Danger) row. `disabled` freezes it for the terminal state while
// keeping the original customIds (so the disabled buttons remain deterministic + testable).
function approvalRow(
  userId: string,
  roleId: string,
  disabled: boolean,
): ActionRowBuilder<ButtonBuilder> {
  const approve = new ButtonBuilder()
    .setCustomId(encodeApproval("approve", userId, roleId))
    .setLabel("Approve")
    .setStyle(ButtonStyle.Success)
    .setDisabled(disabled);
  const deny = new ButtonBuilder()
    .setCustomId(encodeApproval("deny", userId, roleId))
    .setLabel("Deny")
    .setStyle(ButtonStyle.Danger)
    .setDisabled(disabled);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(approve, deny);
}

// Welcome / role-picker container. Each role is a Section: name + member count + a one-line
// "what this unlocks" blurb, with a text-only "Request" button as the Section accessory.
export function buildWelcomeContainer(opts: {
  intro: string;
  roles: WelcomeRole[];
  extraCount?: number;
  footer?: string;
}): ContainerBuilder {
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT.info)
    .addTextDisplayComponents(header("🎭", "Request a Role"))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(opts.intro))
    .addSeparatorComponents(divider());

  for (const r of opts.roles) {
    const count =
      r.memberCount && r.memberCount > 0
        ? ` · ${r.memberCount} ${r.memberCount === 1 ? "member" : "members"}`
        : "";
    const blurb = r.blurb ?? "Request access — an admin reviews it.";
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(text(`**${r.name}**${count}\n-# ${blurb}`))
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(encodePick(r.roleId))
            .setLabel("Request")
            .setStyle(ButtonStyle.Secondary),
        ),
    );
  }

  if (opts.extraCount && opts.extraCount > 0) {
    container.addTextDisplayComponents(text(`-# …and ${opts.extraCount} more — ask an admin`));
  }

  container
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(`-# ${opts.footer ?? "An admin reviews every request."}`));
  return container;
}

// Pending access-request container posted to #access-requests for owner review. Carries a light
// dossier (avatar thumbnail + account-created age) so the owner can decide at a glance. `atSec`
// is a unix-seconds timestamp; omitted ⇒ a static "Awaiting review" footer.
export function buildAccessRequestContainer(opts: {
  userId: string;
  roleId: string;
  roleName: string;
  avatarUrl?: string;
  createdAtSec?: number;
  atSec?: number;
}): ContainerBuilder {
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT.info)
    .addTextDisplayComponents(header("🎭", "Access Request"))
    .addSeparatorComponents(divider());

  addIdentity(
    container,
    identityBody({
      userId: opts.userId,
      roleId: opts.roleId,
      roleName: opts.roleName,
      createdAtSec: opts.createdAtSec,
      statusText: "Awaiting your review",
    }),
    opts.avatarUrl,
  );

  const footer =
    opts.atSec === undefined ? "Awaiting review" : `Requested <t:${opts.atSec}:R>`;
  return container
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(`-# ${footer}`))
    .addActionRowComponents(approvalRow(opts.userId, opts.roleId, false));
}

const DECISION_HEAD: Record<Decision, { icon: string; accent: number }> = {
  approved: { icon: "✅", accent: ACCENT.approved },
  denied: { icon: "⛔", accent: ACCENT.denied },
  member_left: { icon: "⚠️", accent: ACCENT.left },
  error: { icon: "⚠️", accent: ACCENT.denied },
};

function decisionTitle(decision: Decision, roleName: string): string {
  switch (decision) {
    case "approved":
      return `Approved — ${roleName}`;
    case "denied":
      return "Request Declined";
    case "member_left":
      return "Member Left";
    case "error":
      return `Couldn't assign ${roleName}`;
  }
}

function decisionStatus(decision: Decision, reviewerId?: string): string {
  switch (decision) {
    case "approved":
      return reviewerId ? `Approved by <@${reviewerId}>` : "Approved";
    case "denied":
      return reviewerId ? `Declined by <@${reviewerId}>` : "Declined";
    case "member_left":
      return "Member left before review";
    case "error":
      return "Grant failed";
  }
}

// Terminal state of a request message after the owner acts (or the member left, or a grant
// failed). Same dossier body, a decision-colored header + bold Status field (color never carries
// meaning alone), a footer note, and the Approve/Deny row frozen disabled.
export function buildDecisionContainer(opts: {
  decision: Decision;
  userId: string;
  roleId: string;
  roleName: string;
  avatarUrl?: string;
  createdAtSec?: number;
  reviewerId?: string;
  dmFailed?: boolean;
  failureReason?: string;
}): ContainerBuilder {
  const head = DECISION_HEAD[opts.decision];
  const container = new ContainerBuilder()
    .setAccentColor(head.accent)
    .addTextDisplayComponents(header(head.icon, decisionTitle(opts.decision, opts.roleName)))
    .addSeparatorComponents(divider());

  addIdentity(
    container,
    identityBody({
      userId: opts.userId,
      roleId: opts.roleId,
      roleName: opts.roleName,
      createdAtSec: opts.createdAtSec,
      statusText: decisionStatus(opts.decision, opts.reviewerId),
    }),
    opts.avatarUrl,
  );

  let footer: string;
  if (opts.decision === "member_left") {
    footer = `<@${opts.userId}> is no longer in the server`;
  } else if (opts.decision === "error") {
    footer = `${opts.failureReason ?? "Couldn't assign the role"} — check the bot's role is above **${opts.roleName}**`;
  } else {
    footer = opts.dmFailed ? "Could not DM the member" : "The member has been notified by DM";
  }

  return container
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(`-# ${footer}`))
    .addActionRowComponents(approvalRow(opts.userId, opts.roleId, true));
}

// Direct message to the requesting member. A guild-icon Thumbnail re-establishes "which server?"
// (DMs lack server context). No buttons — just the outcome and the next step.
export function buildDmContainer(opts: {
  decision: "approved" | "denied";
  roleName: string;
  guildName: string;
  guildIconUrl?: string;
  jumpChannelId?: string;
  welcomeChannelId?: string;
}): ContainerBuilder {
  const approved = opts.decision === "approved";
  const headLine = approved
    ? `### ✅  You're in — ${opts.roleName}`
    : "### ⛔  Request Declined";

  const pickAgain = opts.welcomeChannelId
    ? ` Want another role? Pick again in <#${opts.welcomeChannelId}> anytime.`
    : "";
  const jump = opts.jumpChannelId ? ` Jump into <#${opts.jumpChannelId}> to get started.` : "";
  const body = approved
    ? `You now have the **${opts.roleName}** role in **${opts.guildName}**.${jump}${pickAgain}`
    : `Your request for **${opts.roleName}** in **${opts.guildName}** wasn't approved right now. No worries — you can request again${opts.welcomeChannelId ? ` from <#${opts.welcomeChannelId}>` : ""} later.`;

  const container = new ContainerBuilder().setAccentColor(
    approved ? ACCENT.approved : ACCENT.denied,
  );

  if (opts.guildIconUrl) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(text(headLine))
        .addTextDisplayComponents(text(body))
        .setThumbnailAccessory(
          new ThumbnailBuilder().setURL(opts.guildIconUrl).setDescription("server icon"),
        ),
    );
  } else {
    container
      .addTextDisplayComponents(text(headLine))
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(text(body));
  }
  return container;
}
