// Deterministic correlation id (ratified decision 3). The SAME value is the log
// scope field AND the X-Correlation-Id header sent to scrypt. NEVER crypto.randomUUID():
//   - slash commands -> "uxie-<interaction.id>"
//   - #inbox capture  -> "uxie-msg-<msg.id>"
export function makeClientTag(i: { id: string }): string {
  return `uxie-${i.id}`;
}

export function makeMessageClientTag(m: { id: string }): string {
  return `uxie-msg-${m.id}`;
}
