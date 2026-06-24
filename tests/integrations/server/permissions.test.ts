import { describe, expect, test } from "bun:test";
import { PermissionFlagsBits } from "discord.js";
import { buildPrivateOverwrites } from "../../../src/integrations/server/permissions.ts";

const EVERYONE_ID = "111111111111111111";
const BOT_ID = "999999999999999999";
const ROLE_A = "222222222222222222";
const ROLE_B = "333333333333333333";

describe("buildPrivateOverwrites", () => {
  test("first element denies ViewChannel for @everyone", () => {
    const overwrites = buildPrivateOverwrites([ROLE_A], EVERYONE_ID, BOT_ID);
    const first = overwrites[0];
    expect(first).toBeDefined();
    expect((first as { id: string }).id).toBe(EVERYONE_ID);
    expect((first as unknown as { deny: bigint[] }).deny).toContain(PermissionFlagsBits.ViewChannel);
  });

  test("one allow element per access role id (in order), each allowing ViewChannel", () => {
    const overwrites = buildPrivateOverwrites([ROLE_A, ROLE_B], EVERYONE_ID, BOT_ID);
    // overwrites: [everyone deny, ROLE_A allow, ROLE_B allow, BOT allow]
    const roleAllows = overwrites.slice(1, 1 + 2);
    expect(roleAllows.map((ow) => (ow as { id: string }).id)).toEqual([ROLE_A, ROLE_B]);
    for (const ow of roleAllows) {
      expect((ow as unknown as { allow: bigint[] }).allow).toContain(PermissionFlagsBits.ViewChannel);
    }
  });

  test("last element allows ViewChannel for the bot user id", () => {
    const overwrites = buildPrivateOverwrites([ROLE_A, ROLE_B], EVERYONE_ID, BOT_ID);
    const last = overwrites[overwrites.length - 1];
    expect((last as { id: string }).id).toBe(BOT_ID);
    expect((last as unknown as { allow: bigint[] }).allow).toContain(PermissionFlagsBits.ViewChannel);
  });

  test("total length === 2 + accessRoleIds.length (everyone deny + N role allows + bot allow)", () => {
    expect(buildPrivateOverwrites([ROLE_A, ROLE_B], EVERYONE_ID, BOT_ID).length).toBe(4);
    expect(buildPrivateOverwrites([ROLE_A], EVERYONE_ID, BOT_ID).length).toBe(3);
  });

  test("zero access roles: only @everyone deny + bot allow", () => {
    const overwrites = buildPrivateOverwrites([], EVERYONE_ID, BOT_ID);
    expect(overwrites.length).toBe(2);
    expect((overwrites[0] as { id: string }).id).toBe(EVERYONE_ID);
    expect((overwrites[0] as unknown as { deny: bigint[] }).deny).toContain(
      PermissionFlagsBits.ViewChannel,
    );
    expect((overwrites[1] as { id: string }).id).toBe(BOT_ID);
    expect((overwrites[1] as unknown as { allow: bigint[] }).allow).toContain(
      PermissionFlagsBits.ViewChannel,
    );
  });
});
