// Shared helpers for asserting Components V2 container payloads. Not a *.test.ts file, so the
// runner does not execute it directly. A container is sent as { flags, components: [builder] };
// these recursively extract the serialized text, buttons, and thumbnails so tests assert real
// structure (no false positives) across both ActionRow buttons and Section accessories.
import { MessageFlags } from "discord.js";

// Depth-first walk over a serialized component tree, visiting nested `.components` arrays AND
// single `.accessory` nodes (Section thumbnail/button accessories live there, not in components).
function walk(node: any, cb: (n: any) => void): void {
  if (!node || typeof node !== "object") return;
  cb(node);
  if (Array.isArray(node.components)) for (const c of node.components) walk(c, cb);
  if (node.accessory) walk(node.accessory, cb);
}

// Serialize the first (and only) container in a send/editReply payload's components array.
export function container(payload: { components?: unknown[] }): any {
  const first = (payload.components ?? [])[0] as { toJSON: () => unknown };
  return first.toJSON();
}

// Concatenated text of every TextDisplay (anywhere in the tree) — titles, bodies, footers.
export function textOf(containerJson: any): string {
  const out: string[] = [];
  walk(containerJson, (n) => {
    if (typeof n.content === "string") out.push(n.content);
  });
  return out.join("\n");
}

// All buttons (type 2) anywhere in the tree — ActionRow buttons and Section accessory buttons.
export function buttonsOf(containerJson: any): any[] {
  const out: any[] = [];
  walk(containerJson, (n) => {
    if (typeof n.custom_id === "string" && n.style !== undefined) out.push(n);
  });
  return out;
}

// All thumbnail media URLs in the tree (Section thumbnail accessories).
export function thumbUrls(containerJson: any): string[] {
  const out: string[] = [];
  walk(containerJson, (n) => {
    if (n.media && typeof n.media.url === "string") out.push(n.media.url);
  });
  return out;
}

// True iff the IsComponentsV2 bit is set on a payload's flags.
export function isV2(flags: unknown): boolean {
  return (
    typeof flags === "number" &&
    (flags & MessageFlags.IsComponentsV2) === MessageFlags.IsComponentsV2
  );
}
