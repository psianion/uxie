import { describe, expect, test, mock } from "bun:test";
import { buildEditRoleCommand } from "../../../../src/integrations/server/commands/edit-role.ts";
import { ConfigError } from "../../../../src/lib/errors.ts";

const ctx = { clientTag: "uxie-x", log: { info() {}, warn() {}, error() {} } as any };
const GUILD_ID = "111111111111111111";

function roleInteraction(opts: {
  roleId?: string;
  managed?: boolean;
  name?: string | null;
  color?: string | null;
  color_hex?: string | null;
  hoist?: boolean | null;
  position?: number | null;
} = {}): any {
  const edited = { id: opts.roleId ?? "222", position: opts.position ?? 3 };
  const rolesEdit = mock(async (_id: string, _e: unknown) => edited);
  return {
    commandName: "edit-role",
    guild: { id: GUILD_ID, name: "G", roles: { edit: rolesEdit } },
    options: {
      getRole: mock(() => ({
        id: opts.roleId ?? "222",
        name: "the-role",
        managed: opts.managed ?? false,
      })),
      getString: mock((n: string) =>
        n === "name"
          ? opts.name ?? null
          : n === "color"
            ? opts.color ?? null
            : n === "color_hex"
              ? opts.color_hex ?? null
              : null,
      ),
      getBoolean: mock((n: string) => (n === "hoist" ? opts.hoist ?? null : null)),
      getInteger: mock(() => opts.position ?? null),
    },
    editReply: mock(async (_: unknown) => {}),
    __rolesEdit: rolesEdit,
  };
}

describe("/edit-role", () => {
  test("@everyone (role id == guild id) is rejected", async () => {
    const cmd = buildEditRoleCommand();
    const i = roleInteraction({ roleId: GUILD_ID, name: "x" });
    await expect(cmd.execute(i, ctx)).rejects.toThrow(ConfigError);
    expect(i.__rolesEdit).not.toHaveBeenCalled();
  });

  test("managed role is rejected", async () => {
    const cmd = buildEditRoleCommand();
    const i = roleInteraction({ managed: true, name: "x" });
    await expect(cmd.execute(i, ctx)).rejects.toThrow(ConfigError);
  });

  test("no options → ConfigError", async () => {
    const cmd = buildEditRoleCommand();
    const i = roleInteraction();
    await expect(cmd.execute(i, ctx)).rejects.toThrow(ConfigError);
  });

  test("partial edit sends only provided keys", async () => {
    const cmd = buildEditRoleCommand();
    const i = roleInteraction({ name: "renamed", hoist: true });
    await cmd.execute(i, ctx);
    expect(i.__rolesEdit).toHaveBeenCalledWith("222", { name: "renamed", hoist: true });
  });

  test("named color maps to hex; Default resets color to 0", async () => {
    const cmd = buildEditRoleCommand();
    const red = roleInteraction({ color: "Red" });
    await cmd.execute(red, ctx);
    expect(red.__rolesEdit).toHaveBeenCalledWith("222", { color: 0xed4245 });

    const def = roleInteraction({ color: "Default" });
    await cmd.execute(def, ctx);
    expect(def.__rolesEdit).toHaveBeenCalledWith("222", { color: 0 });
  });

  test("bad color_hex → ConfigError before any edit", async () => {
    const cmd = buildEditRoleCommand();
    const i = roleInteraction({ color_hex: "zzz" });
    await expect(cmd.execute(i, ctx)).rejects.toThrow(ConfigError);
    expect(i.__rolesEdit).not.toHaveBeenCalled();
  });
});
