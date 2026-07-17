// Pure item extraction for the triage flow: pull every link and attachment off a Discord
// message. Pure + structurally typed so it is unit-testable with no live client.

export interface TriageItem {
  kind: "link" | "attachment";
  url: string;
  label: string; // host for links, filename for attachments
  contentType?: string;
}

// Minimal structural shape of the message fields triage reads (a real Message satisfies it).
export interface TriageSource {
  content: string;
  attachments: Iterable<{ url: string; name: string; contentType: string | null }>;
  embeds: Iterable<{ url: string | null }>;
}

const URL_RE = /https?:\/\/[^\s<>|)\]"']+/g;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}

// Links come from the raw content plus embed urls (covers app-embedded shares whose url isn't
// in the text); attachments are taken as-is. Deduped by url, order preserved.
export function extractItems(msg: TriageSource): TriageItem[] {
  const items: TriageItem[] = [];
  const seen = new Set<string>();
  const push = (item: TriageItem) => {
    if (seen.has(item.url)) return;
    seen.add(item.url);
    items.push(item);
  };

  for (const url of msg.content.match(URL_RE) ?? []) {
    push({ kind: "link", url, label: hostOf(url) });
  }
  for (const e of msg.embeds) {
    if (e.url) push({ kind: "link", url: e.url, label: hostOf(e.url) });
  }
  for (const a of msg.attachments) {
    push({ kind: "attachment", url: a.url, label: a.name, contentType: a.contentType ?? undefined });
  }
  return items;
}
