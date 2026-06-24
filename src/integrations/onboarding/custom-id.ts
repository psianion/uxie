// Pure encode/decode of onboarding customIds (no discord.js runtime import). The decoder
// THROWS ConfigError on any malformed / wrong-namespace input — never returns a silent
// usable value. This is the locked contract for all consumers (role-pick-handler,
// approval-handler, tests). Format (colon-delimited, namespace "onboard", <=100 chars):
//   onboard:pick:<roleId>
//   onboard:approve:<userId>:<roleId>
//   onboard:deny:<userId>:<roleId>
import { ConfigError } from "../../lib/errors.ts";
import type { OnboardCustomId } from "./types.ts";

const NS = "onboard";
const SNOWFLAKE = /^[0-9]{17,20}$/;

export function encodePick(roleId: string): string {
  return `${NS}:pick:${roleId}`;
}

export function encodeApproval(
  action: "approve" | "deny",
  userId: string,
  roleId: string,
): string {
  return `${NS}:${action}:${userId}:${roleId}`;
}

export function decodeOnboardCustomId(raw: string): OnboardCustomId {
  const parts = raw.split(":");
  if (parts[0] !== NS) {
    throw malformed(raw);
  }

  const action = parts[1];
  if (action === "pick") {
    if (parts.length !== 3) throw malformed(raw);
    const roleId = parts[2];
    if (roleId === undefined || !SNOWFLAKE.test(roleId)) throw malformed(raw);
    return { kind: "pick", roleId };
  }

  if (action === "approve" || action === "deny") {
    if (parts.length !== 4) throw malformed(raw);
    const userId = parts[2];
    const roleId = parts[3];
    if (userId === undefined || !SNOWFLAKE.test(userId)) throw malformed(raw);
    if (roleId === undefined || !SNOWFLAKE.test(roleId)) throw malformed(raw);
    return { kind: action, userId, roleId };
  }

  throw malformed(raw);
}

function malformed(raw: string): ConfigError {
  return new ConfigError("onboard_custom_id", `malformed onboard customId: ${raw}`);
}
