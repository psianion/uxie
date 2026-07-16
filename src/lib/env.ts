// SOLE source of process.env access — no other module reads env directly
// (UXIE-DISCORD-GUIDELINES §17 / ratified decision 11). Validated at boot; on
// failure we throw ConfigError naming the offending field so the operator knows
// exactly what to fix and the boot path can log + exit 1.
import { z } from "zod";
import { ConfigError } from "./errors.ts";
import { parseRestartCommand } from "./exec/restart-scrypt.ts";

// Truthy-string → boolean coercion for opt-in flags ("1"/"true" ⇒ true, anything else ⇒ false).
const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === "1" || v === "true")
  .pipe(z.boolean());

// UX-SEC-002: the SCRYPT_AUTH bearer is attached to every Scrypt request, so the URL must keep
// it off untrusted wire. Allow https:// to any host; allow http:// only to a loopback literal
// (localhost / 127.0.0.1 / [::1], where traffic never leaves the host). A plaintext http:// to a
// remote host is rejected at boot — pointing Scrypt at a non-loopback host requires https://.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const scryptUrl = z
  .string()
  .url()
  .refine(
    (raw) => {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        return false;
      }
      if (u.protocol === "https:") return true;
      return u.protocol === "http:" && LOOPBACK.has(u.hostname);
    },
    {
      message:
        "must be https:// or http:// to a loopback host (localhost/127.0.0.1/[::1]); plaintext http:// to a remote host would leak SCRYPT_AUTH",
    },
  );

const schema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APP_ID: z.string().min(1),
  DISCORD_DEV_GUILD_ID: z.string().min(1),
  DISCORD_OWNER_ID: z.string().min(1),
  SCRYPT_SERVER_URL: scryptUrl,
  SCRYPT_AUTH: z.string().min(1),
  ALLOW_SCRYPT_RESTART: bool.default(false),
  SCRYPT_RESTART_CMD: z.string().min(1).default("docker compose restart scrypt"),
  // Deployment label shown in the /ping panel's Host row (e.g. "local", "vps", "prod").
  // Free-form so any environment name works; defaults to "local".
  UXIE_ENV: z.string().min(1).default("local"),

  // para-raid v2 module (D4/ratified decision 12) — optional group, all-or-none (enforced
  // below via superRefine; zod has no built-in all-or-none). Module + message intents are on
  // iff the group is present (see paraRaidEnabled). PARARAID_WEBHOOK_PORT always has a value
  // (coerced, defaulted) since it's harmless when the module is off — nothing binds to it.
  PARARAID_SOCKET: z.string().min(1).optional(),
  PARARAID_ADAPTER_TOKEN: z.string().min(1).optional(),
  PARARAID_SIGNING_SECRET: z.string().min(1).optional(),
  PARARAID_WEBHOOK_PORT: z.coerce.number().int().positive().default(18901),
  // U6: channel where nightly librarian sessions (adapter_ref "librarian:<utc-date>", opened by
  // CLI, not /raid) get their digest thread. Deliberately OUTSIDE the all-or-none group and
  // optional — absent means the librarian handler is off and librarian:* events are dropped.
  LIBRARIAN_CHANNEL_ID: z
    .string()
    .regex(/^\d{17,20}$/, "must be a Discord channel id (snowflake)")
    .optional(),
});

const PARARAID_GROUP = ["PARARAID_SOCKET", "PARARAID_ADAPTER_TOKEN", "PARARAID_SIGNING_SECRET"] as const;

const withParaRaidGroup = schema.superRefine((val, ctx) => {
  const missing = PARARAID_GROUP.filter((k) => val[k] === undefined);
  if (missing.length === 0 || missing.length === PARARAID_GROUP.length) return; // none or all — fine
  // Partial group: name each missing field individually so the boot error lists exactly what's absent.
  for (const key of missing) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [key],
      message: "para-raid env group is all-or-none — set together with the other PARARAID_* vars",
    });
  }
});

export type Env = z.infer<typeof schema>;

export function parseEnv(src: Record<string, string | undefined> = process.env): Env {
  const result = withParaRaidGroup.safeParse(src);
  if (!result.success) {
    // Surface the failed field name(s) so the boot log + the operator know exactly what to fix.
    const fields = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new ConfigError("config", `invalid config — env missing/invalid: ${fields}`, result.error);
  }
  // Only validate the restart command when the capability is actually enabled — a disabled
  // restart never runs, so a malformed command must not block boot.
  if (result.data.ALLOW_SCRYPT_RESTART) {
    parseRestartCommand(result.data.SCRYPT_RESTART_CMD); // throws ConfigError on invalid
  }
  return result.data;
}

// A11: derived outside the zod schema (superRefine only validates, it can't add a computed
// field to the inferred type). The group is enforced all-or-none above, so checking one field
// is enough. env.ts stays the sole process.env reader — this reads the already-parsed Env.
export function paraRaidEnabled(env: Env): boolean {
  return env.PARARAID_SOCKET !== undefined;
}
