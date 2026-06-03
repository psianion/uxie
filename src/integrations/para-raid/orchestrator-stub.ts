// v2 module seam (ratified decision 12). Inert in v1: uxie is a stateless
// translation layer, so dispatch() throws NotImplemented. This file exists only to
// fix the attachment point for the future para-raid orchestrator; it is never wired
// into the boot path.

export class NotImplementedError extends Error {
  constructor(message = "para-raid orchestrator is not implemented in v1") {
    super(message);
    this.name = "NotImplementedError";
  }
}

/**
 * Reserved entry point for the v2 para-raid orchestrator. Always throws in v1.
 */
export function dispatch(_input?: unknown): never {
  throw new NotImplementedError();
}
