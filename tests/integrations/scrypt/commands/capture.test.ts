import { describe, expect, test, mock } from "bun:test";
import { buildCaptureCommand, titleFrom } from "../../../../src/integrations/scrypt/commands/capture.ts";
import { ScryptError } from "../../../../src/lib/errors.ts";
import { fakeInteraction } from "../../../helpers.ts";

const ctx = { clientTag: "uxie-iid-1", log: { info() {}, warn() {}, error() {} } as any };

function captureInteraction(text: string) {
  return fakeInteraction({
    deferred: true,
    options: { getString: mock((_: string, _req?: boolean) => text) },
  });
}

describe("/capture", () => {
  test("command data name is 'capture' with default builder shape (decision 7)", () => {
    const cmd = buildCaptureCommand({} as any);
    expect(cmd.data.name).toBe("capture");
    expect((cmd.data as any).toJSON().default_member_permissions).toBe("0");
    expect(cmd.defer).toBeUndefined(); // router auto-defers
  });

  test("files the text via createNote and confirms with the vault path", async () => {
    const createNote = mock(async () => ({ path: "projects/_inbox/other/2026-07-16-0930-buy-milk.md" }));
    const cmd = buildCaptureCommand({ createNote } as any);
    const i = captureInteraction("buy milk\nand eggs");
    await cmd.execute(i, ctx);
    expect(createNote).toHaveBeenCalledWith({
      title: "buy milk",
      content: "buy milk\nand eggs",
      clientTag: "uxie-iid-1",
    });
    expect(i.editReply.mock.calls[0][0]).toBe(
      "captured → `projects/_inbox/other/2026-07-16-0930-buy-milk.md`",
    );
  });

  test("passes the SAME deterministic clientTag on a retried interaction (idempotent capture)", async () => {
    const tags: string[] = [];
    const createNote = mock(async (input: { clientTag: string }) => {
      tags.push(input.clientTag);
      return { path: "projects/_inbox/other/x.md" };
    });
    const cmd = buildCaptureCommand({ createNote } as any);
    await cmd.execute(captureInteraction("hi"), ctx);
    await cmd.execute(captureInteraction("hi"), ctx); // Discord retry: same interaction ⇒ same ctx
    expect(tags).toEqual(["uxie-iid-1", "uxie-iid-1"]);
  });

  test("a ScryptError bubbles to the router (body is try/catch-free)", async () => {
    const createNote = mock(async () => {
      throw new ScryptError("scrypt_unreachable", "scrypt unreachable");
    });
    const cmd = buildCaptureCommand({ createNote } as any);
    const i = captureInteraction("hi");
    await expect(cmd.execute(i, ctx)).rejects.toBeInstanceOf(ScryptError);
    expect(i.editReply).not.toHaveBeenCalled();
  });
});

describe("titleFrom", () => {
  test("first non-empty line, whitespace collapsed", () => {
    expect(titleFrom("\n\n  buy   milk  \nrest")).toBe("buy milk");
  });

  test("caps at 80 chars with an ellipsis", () => {
    const t = titleFrom("x".repeat(200));
    expect(t.length).toBe(80);
    expect(t.endsWith("…")).toBe(true);
  });

  test("falls back to 'capture' for whitespace-only text", () => {
    expect(titleFrom("   \n  ")).toBe("capture");
  });
});
