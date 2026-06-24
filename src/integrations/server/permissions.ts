// Pure builder for private-channel permission overwrites. The access roles are now supplied
// per-command (operator-driven via the /create-channel|category access_role options), NOT read
// from guild config. Produces, in order:
//   1. deny @everyone ViewChannel
//   2. allow each access role id ViewChannel
//   3. allow the bot user id ViewChannel (so the bot keeps access even WITHOUT Administrator)
// Returns the overwrites array in the shape channels.create({ permissionOverwrites }) accepts.
// Pure: reads nothing from process.env or module-level config — every id is passed in.
import { PermissionFlagsBits } from "discord.js";
import type { OverwriteResolvable } from "discord.js";

export function buildPrivateOverwrites(
  accessRoleIds: readonly string[],
  everyoneId: string,
  botUserId: string,
): OverwriteResolvable[] {
  const overwrites: OverwriteResolvable[] = [
    { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
  ];
  for (const roleId of accessRoleIds) {
    overwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel] });
  }
  overwrites.push({ id: botUserId, allow: [PermissionFlagsBits.ViewChannel] });
  return overwrites;
}
