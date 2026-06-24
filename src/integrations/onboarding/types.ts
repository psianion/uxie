// Shared onboarding types (no runtime). The customId discriminated union is the decoded form
// produced by `decodeOnboardCustomId` (see ./custom-id.ts). The picker is now operator-driven
// by a flat list of role ids (`guildConfig.pickableRoleIds`) with no emote/label, so there is
// no longer a `RolePickerEntry` shape — button labels and the {roles} list come from the live
// role names resolved off the guild at render time.
export type PickCustomId = { kind: "pick"; roleId: string };

export type ApprovalCustomId = { kind: "approve" | "deny"; userId: string; roleId: string };

export type OnboardCustomId = PickCustomId | ApprovalCustomId;
