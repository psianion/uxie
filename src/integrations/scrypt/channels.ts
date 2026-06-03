// Channel filter for #inbox passive capture (Design §6.2). Pure predicate, no IO —
// unit-tested alongside the other pure helpers (UXIE §… testing). The actual
// INBOX_CHANNEL_ID comes from lib/env.ts (decision 11); this only compares ids.
export function isInboxChannel(channelId: string, inboxId: string): boolean {
  return channelId === inboxId;
}
