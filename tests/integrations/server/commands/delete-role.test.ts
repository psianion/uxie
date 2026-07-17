import { describe, expect, test, mock } from "bun:test";
import { buildDeleteRoleCommand } from "../../../../src/integrations/server/commands/delete-role.ts";
import { ConfigError } from "../../../../src/lib/errors.ts";

const ctx = { clientTag: "uxie-x", log: { info() {}, warn() {}, error() {} } as any };
const GUILD_ID = "111111111111111111";
const V2 = 1 << 15;

function delInteraction(opts: {
  roleId?: string;
  managed?: boolean;
  confirm?: boolean;
  reason?: string | null;
} = {}): any {
  const rolesDelete = mock(async (_id: string, _r?: string) => {});
  return {
    commandName: "delete-role",
    guild: { id: GUILD_ID, name: "G", roles: { delete: rolesDelete } },
    options: {
      getRole: mock(() => ({
        id: opts.roleId ?? "333",
        name: "doomed-role",
        managed: opts.managed ?? false,
      })),
      getBoolean: mock(() => opts.confirm ?? false),
      getString: mock(() => opts.reason ?? null),
    },
    editReply: mock(async (_: unknown) => {}),
    __rolesDelete: rolesDelete,
  };
}

describe("/delete-role", () => {
  test("confirm=false → ConfigError, nothing deleted", async () => {
    const cmd = buildDeleteRoleCommand();
    const i = delInteraction({ confirm: false });
    await expect(cmd.execute(i, ctx)).rejects.toThrow(ConfigError);
    expect(i.__rolesDelete).not.toHaveBeenCalled();
  });

  test("@everyone is rejected even when confirmed", async () => {
    const cmd = buildDeleteRoleCommand();
    const i = delInteraction({ confirm: true, roleId: GUILD_ID });
    await expect(cmd.execute(i, ctx)).rejects.toThrow(ConfigError);
  });

  test("managed role is rejected", async () => {
    const cmd = buildDeleteRoleCommand();
    const i = delInteraction({ confirm: true, managed: true });
    await expect(cmd.execute(i, ctx)).rejects.toThrow(ConfigError);
  });

  test("confirmed delete calls roles.delete and renders V2 panel", async () => {
    const cmd = buildDeleteRoleCommand();
    const i = delInteraction({ confirm: true, reason: "obsolete" });
    await cmd.execute(i, ctx);
    expect(i.__rolesDelete).toHaveBeenCalledWith("333", "obsolete");
    const arg = i.editReply.mock.calls[0][0];
    expect(arg.flags & V2).toBe(V2);
  });
});
