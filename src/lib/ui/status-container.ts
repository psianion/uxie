// Pure Components V2 render kit. Maps a backend-agnostic StatusModel to a
// ContainerBuilder: accent bar + header (title · badge) + separator + one text
// line per row + separator + footer + an optional action row of buttons. The
// caller sends it with { flags: Ephemeral | IsComponentsV2, components: [container] }.
// Pure and synchronous so it is unit-testable via .toJSON() with no live client.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
} from "discord.js";

export type Health = "ok" | "degraded" | "down";

export interface StatusRow {
  icon: string;
  label: string;
  value: string;
}

export interface StatusButton {
  id: string;
  label: string;
  emoji?: string;
  style: ButtonStyle;
  disabled?: boolean;
}

export interface StatusModel {
  title: string;
  health: Health;
  badge: string;
  rows: StatusRow[];
  footer: string;
  buttons?: StatusButton[];
}

export const ACCENT: Record<Health, number> = {
  ok: 0x57f287,
  degraded: 0xfee75c,
  down: 0xed4245,
};

export function buildStatusContainer(m: StatusModel): ContainerBuilder {
  const header = `### ${m.title}  ·  ${m.badge}`;
  const body = m.rows.map((r) => `${r.icon}  **${r.label}** — ${r.value}`).join("\n");

  const container = new ContainerBuilder()
    .setAccentColor(ACCENT[m.health])
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(header))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${m.footer}`));

  if (m.buttons && m.buttons.length > 0) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const b of m.buttons) {
      const btn = new ButtonBuilder().setCustomId(b.id).setLabel(b.label).setStyle(b.style);
      if (b.emoji) btn.setEmoji(b.emoji);
      if (b.disabled) btn.setDisabled(true);
      row.addComponents(btn);
    }
    container.addActionRowComponents(row);
  }

  return container;
}
