import { describe, expect, test, mock } from "bun:test";
import { onMemberJoin } from "../../../src/integrations/onboarding/member-join.ts";

const GUEST_ROLE = "100000000000000003";

// Inline GuildMember mock: { user: { bot }, id, roles: { add } }.
function fakeMember(over: Record<string, unknown> = {}): any {
  return {
    id: "400000000000000001",
    user: { bot: false },
    roles: { add: mock(async () => {}) },
    ...over,
  };
}

describe("onMemberJoin", () => {
  test("assigns the guest role to a human member", async () => {
    const member = fakeMember();
    await onMemberJoin(member, GUEST_ROLE);
    expect(member.roles.add).toHaveBeenCalledTimes(1);
    expect(member.roles.add).toHaveBeenCalledWith(GUEST_ROLE);
  });

  test("skips bots (roles.add NOT called)", async () => {
    const member = fakeMember({ user: { bot: true } });
    await onMemberJoin(member, GUEST_ROLE);
    expect(member.roles.add).not.toHaveBeenCalled();
  });

  test("does not throw when roles.add rejects (gateway handler swallows + logs)", async () => {
    const member = fakeMember({
      roles: { add: mock(async () => { throw new Error("missing perms"); }) },
    });
    await expect(onMemberJoin(member, GUEST_ROLE)).resolves.toBeUndefined();
    expect(member.roles.add).toHaveBeenCalledTimes(1);
  });
});
