// Privileged Scrypt restart — the ONLY place uxie touches the host. This file: parse +
// validate the configured command at boot. Execution/guarding is appended below.
//
// Hard rules: no shell (fixed argv only), no Discord-derived input ever reaches argv, the
// leading binary is allowlisted, and any shell metacharacter is a boot-time ConfigError.
import { execFile, type ExecFileException } from "node:child_process";
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

export interface RestartResult {
  ok: boolean;
  code: number | null;
  stderr: string;
}

export type RestartRunner = (
  argv: string[],
  o: { cwd: string; timeoutMs: number; env: Record<string, string> },
) => Promise<{ code: number | null; stderr: string }>;

const RESTART_COOLDOWN_MS = 60_000;
const RESTART_TIMEOUT_MS = 30_000;
const MAX_STDERR = 500;

// Single-flight + cooldown gate. `now` is injectable so tests can advance the clock.
export function createRestartGuard(now: () => number = Date.now) {
  let inFlight = false;
  let lastAt = -Infinity;
  return {
    tryAcquire():
      | { ok: true }
      | { ok: false; reason: "in_flight" | "cooldown"; retryInMs: number } {
      if (inFlight) return { ok: false, reason: "in_flight", retryInMs: 0 };
      const since = now() - lastAt;
      if (since < RESTART_COOLDOWN_MS) {
        return { ok: false, reason: "cooldown", retryInMs: RESTART_COOLDOWN_MS - since };
      }
      inFlight = true;
      return { ok: true };
    },
    release(): void {
      inFlight = false;
      lastAt = now();
    },
  };
}

export function redactStderr(s: string, secrets: string[]): string {
  let out = s;
  for (const sec of secrets) {
    if (sec) out = out.split(sec).join("***");
  }
  return out.length > MAX_STDERR ? `${out.slice(0, MAX_STDERR)}…` : out;
}

// Default runner: execFile with NO shell, a minimal env, and a hard timeout. The child
// inherits only PATH (+ DOCKER_HOST if set) — never DISCORD_BOT_TOKEN / SCRYPT_AUTH.
const defaultRunner: RestartRunner = (argv, o) =>
  new Promise((resolve) => {
    const bin = argv[0] ?? "";
    const args = argv.slice(1);
    execFile(
      bin,
      args,
      { cwd: o.cwd, timeout: o.timeoutMs, env: o.env, windowsHide: true, encoding: "utf8" },
      (err: ExecFileException | null, _stdout: string, stderr: string) => {
        const code = typeof err?.code === "number" ? err.code : err ? 1 : 0;
        resolve({ code, stderr: stderr ?? (err ? String(err.message) : "") });
      },
    );
  });

export function minimalChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.DOCKER_HOST) env.DOCKER_HOST = process.env.DOCKER_HOST;
  return env;
}

export async function restartScrypt(
  cfg: { command: string; secrets: string[] },
  runner: RestartRunner = defaultRunner,
  o: { cwd?: string; timeoutMs?: number } = {},
): Promise<RestartResult> {
  const argv = parseRestartCommand(cfg.command); // re-validate at call time (defence in depth)
  const { code, stderr } = await runner(argv, {
    cwd: o.cwd ?? process.cwd(),
    timeoutMs: o.timeoutMs ?? RESTART_TIMEOUT_MS,
    env: minimalChildEnv(),
  });
  return { ok: code === 0, code, stderr: redactStderr(stderr, cfg.secrets) };
}
