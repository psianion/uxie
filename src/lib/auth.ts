// Owner allowlist guard (ratified decision 9). assertOwner is ROUTER-LOCATED:
// it fires inside interaction-router AND message-router BEFORE deferReply/execute,
// never inside command bodies. Works for both Interaction (user.id) and Message
// (author.id) shapes so a single guard covers slash commands and #inbox capture.
import { NotOwnerError } from "./errors.ts";

type Actor = { user?: { id: string } } | { author?: { id: string } };

function getActorId(a: Actor): string | undefined {
  if ("user" in a && a.user) return a.user.id;
  if ("author" in a && a.author) return a.author.id;
  return undefined;
}

export function assertOwner(actor: Actor, ownerId: string): void {
  const id = getActorId(actor);
  if (id !== ownerId) throw new NotOwnerError("not_owner", "not for you");
}
