// Error taxonomy (UXIE-DISCORD-GUIDELINES §14.1).
// UxieError carries a stable `code` (for log scoping + user-facing message) and an
// optional `cause`. Specific subclasses encode retryability: Timeout is retryable,
// Auth is not. `name` is derived from `new.target.name` so every subclass reports
// its own constructor name without restating it.
export class UxieError extends Error {
  constructor(
    public code: string,
    message: string,
    public override cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
  toUserMessage(): string {
    return `${this.code}: ${this.message}`;
  }
}

export class ConfigError extends UxieError {} // env / startup misconfig
export class NotOwnerError extends UxieError {} // owner-gate failure
export class ScryptError extends UxieError {} // any scrypt-side fault
export class ScryptTimeoutError extends ScryptError {} // retryable
export class ScryptAuthError extends ScryptError {} // not retryable
export class ScryptBadRequestError extends ScryptError {} // not retryable
