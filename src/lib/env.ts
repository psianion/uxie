// SOLE source of process.env access — no other module reads env directly
// (UXIE-DISCORD-GUIDELINES §17 / ratified decision 11). Validated at boot; on
// failure we throw ConfigError naming the offending field so the operator knows
// exactly what to fix and the boot path can log + exit 1.
import { z } from "zod";
import { ConfigError } from "./errors.ts";

const schema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APP_ID: z.string().min(1),
  DISCORD_DEV_GUILD_ID: z.string().min(1),
  DISCORD_OWNER_ID: z.string().min(1),
  SCRYPT_SERVER_URL: z.string().url(),
  SCRYPT_MCP_URL: z.string().url(),
  SCRYPT_AUTH: z.string().min(1),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(src: Record<string, string | undefined> = process.env): Env {
  const result = schema.safeParse(src);
  if (!result.success) {
    // Surface the failed field name(s) so the boot log + the operator know exactly what to fix.
    const fields = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new ConfigError("config", `invalid config — env missing/invalid: ${fields}`, result.error);
  }
  return result.data;
}
