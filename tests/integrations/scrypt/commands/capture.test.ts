import { describe, expect, test, mock } from "bun:test";
import { buildCaptureCommand } from "../../../../src/integrations/scrypt/commands/capture.ts";
import { fakeInteraction } from "../../../helpers.ts";

function fakeRest(ingest: ReturnType<typeof mock>) {
  return { ingest } as any;
}

const ctx = {
  clientTag: "uxie-iid-1",
  log: { info: () => {}, warn: () => {}, error: () => {} } as any,
};

describe("/capture", () => {
  test("default kind is 'note', passes text + clientTag to ingest", async () => {
    const ingest = mock(async () => ({ path: "notes/inbox/hello.md", permalink: "https://s/n/hello" }));
    const cmd = buildCaptureCommand(fakeRest(ingest));
    const i = fakeInteraction({
      deferred: true,
      options: { getString: mock((name: string) => (name === "text" ? "hello" : null)) },
    });
    await cmd.execute(i, ctx);
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "note", content: "hello", clientTag: "uxie-iid-1" }),
    );
    expect(i.editReply).toHaveBeenCalled();
  });

  test("uses kind option when present", async () => {
    const ingest = mock(async () => ({ path: "notes/thought/x.md", permalink: "https://s/n/x" }));
    const cmd = buildCaptureCommand(fakeRest(ingest));
    const i = fakeInteraction({
      deferred: true,
      options: {
        getString: mock((n: string) => (n === "text" ? "deep thought" : n === "kind" ? "thought" : null)),
      },
    });
    await cmd.execute(i, ctx);
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ kind: "thought" }));
  });

  test("editReply payload suppresses mentions (decision 8) and carries the embed", async () => {
    const ingest = mock(async () => ({ path: "notes/inbox/hello.md", permalink: "https://s/n/hello" }));
    const cmd = buildCaptureCommand(fakeRest(ingest));
    let payload: any = null;
    const i = fakeInteraction({
      deferred: true,
      editReply: mock(async (p: unknown) => {
        payload = p;
      }),
      options: { getString: mock((name: string) => (name === "text" ? "hello" : null)) },
    });
    await cmd.execute(i, ctx);
    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(Array.isArray(payload.embeds)).toBe(true);
    expect(payload.embeds.length).toBe(1);
  });

  test("data has kind choice option with exactly 3 values", () => {
    const cmd = buildCaptureCommand(fakeRest(mock(async () => ({ path: "", permalink: "" }))));
    const json: any = (cmd.data as any).toJSON();
    const kindOpt = json.options.find((o: any) => o.name === "kind");
    expect(kindOpt.choices.map((c: any) => c.value).sort()).toEqual(["idea", "note", "thought"]);
  });

  test("builder applies the default shape (guild-only, owner-permissionless)", () => {
    const cmd = buildCaptureCommand(fakeRest(mock(async () => ({ path: "", permalink: "" }))));
    const json: any = (cmd.data as any).toJSON();
    expect(json.name).toBe("capture");
    // decision 7: setDefaultMemberPermissions(0n) -> "0" in the serialized builder.
    expect(json.default_member_permissions).toBe("0");
  });
});
