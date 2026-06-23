// Privileged Scrypt restart — the ONLY place uxie touches the host. This file: parse +
// validate the configured command at boot. Execution/guarding is appended below.
//
// Hard rules: no shell (fixed argv only), no Discord-derived input ever reaches argv, the
// leading binary is allowlisted, and any shell metacharacter is a boot-time ConfigError.
import { ConfigError } from "../errors.ts";

export const RESTART_BINARY_ALLOWLIST = ["docker"] as const;

const SHELL_META = /[;|&$><`()'"\\]/;

export function parseRestartCommand(raw: string): string[] {
  if (SHELL_META.test(raw)) {
    throw new ConfigError("config", "SCRYPT_RESTART_CMD contains a forbidden shell metacharacter");
  }
  const argv = raw.trim().split(/\s+/).filter((t) => t.length > 0);
  if (argv.length === 0) {
    throw new ConfigError("config", "SCRYPT_RESTART_CMD is empty");
  }
  if (!RESTART_BINARY_ALLOWLIST.includes(argv[0] as (typeof RESTART_BINARY_ALLOWLIST)[number])) {
    throw new ConfigError(
      "config",
      `SCRYPT_RESTART_CMD binary '${argv[0]}' is not allowlisted (allowed: ${RESTART_BINARY_ALLOWLIST.join(", ")})`,
    );
  }
  return argv;
}
