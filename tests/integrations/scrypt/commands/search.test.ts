import { describe, expect, test, mock } from "bun:test";
import {
  buildSearchCommand,
  MIN_CONFIDENT_SCORE,
} from "../../../../src/integrations/scrypt/commands/search.ts";
import { ScryptError } from "../../../../src/lib/errors.ts";
import { fakeInteraction } from "../../../helpers.ts";

const ctx = { clientTag: "uxie-iid-1", log: { info() {}, warn() {}, error() {} } as any };

const V2 = 1 << 15; // MessageFlags.IsComponentsV2
const EPHEMERAL = 1 << 6; // 64

function hit(over: Record<string, unknown> = {}) {
  return {
    path: "projects/scrypt/spec/vault-sync.md",
    title: "Vault Sync Design",
    project: "scrypt",
    doc_type: "spec",
    description: "how the vault syncs",
    excerpt: "body prefix",
    score: 2 / 61, // rank 1 in both rankers
    fts_rank: 1,
    sem_rank: 1,
    ...over,
  };
}

function searchInteraction(query = "vault sync") {
  return fakeInteraction({
    deferred: false,
    options: { getString: mock((_: string, _req?: boolean) => query) },
  });
}

function fakeRest(res: unknown) {
  return { hybridSearch: mock(async () => res) } as any;
}

describe("/search", () => {
  test("opts out of auto-defer (Components V2 must be set at reply time)", () => {
    expect(buildSearchCommand(fakeRest({ query: "", hits: [] })).defer).toBe(false);
  });

  test("command data name is 'search' with default builder shape (decision 7)", () => {
    const cmd = buildSearchCommand(fakeRest({ query: "", hits: [] }));
    expect(cmd.data.name).toBe("search");
    expect((cmd.data as any).toJSON().default_member_permissions).toBe("0");
  });

  test("renders confident hits as an ephemeral Components V2 panel", async () => {
    const rest = fakeRest({ query: "vault sync", hits: [hit()] });
    const cmd = buildSearchCommand(rest);
    const i = searchInteraction();
    await cmd.execute(i, ctx);
    expect(rest.hybridSearch).toHaveBeenCalledWith("vault sync", {
      limit: 5,
      clientTag: "uxie-iid-1",
    });
    const payload = i.reply.mock.calls[0][0];
    expect(payload.flags & V2).toBe(V2);
    expect(payload.flags & EPHEMERAL).toBe(EPHEMERAL);
    const json = JSON.stringify(payload.components[0].toJSON());
    expect(json).toContain("Vault Sync Design");
    expect(json).toContain("scrypt/spec");
    expect(json).toContain("how the vault syncs");
    expect(json).toContain("projects/scrypt/spec/vault-sync.md");
  });

  test("no hits ⇒ 'no confident match' + /raid suggestion, no panel", async () => {
    const cmd = buildSearchCommand(fakeRest({ query: "q", hits: [] }));
    const i = searchInteraction("q");
    await cmd.execute(i, ctx);
    const payload = i.reply.mock.calls[0][0];
    expect(payload.content).toContain("no confident match");
    expect(payload.content).toContain("/raid");
    expect(payload.components).toBeUndefined();
  });

  test("single-source top hit (score = 1/61, the single-ranker ceiling) is gated", async () => {
    const weak = hit({ score: 1 / 61, fts_rank: 1, sem_rank: null });
    const cmd = buildSearchCommand(fakeRest({ query: "q", hits: [weak] }));
    const i = searchInteraction("q");
    await cmd.execute(i, ctx);
    expect(i.reply.mock.calls[0][0].content).toContain("no confident match");
  });

  test("a score just above the single-ranker ceiling passes the gate", async () => {
    // worst possible two-ranker agreement within the 25-hit window: 1/85 + 1/85
    const twoSource = hit({ score: 2 / 85, fts_rank: 25, sem_rank: 25 });
    const cmd = buildSearchCommand(fakeRest({ query: "q", hits: [twoSource] }));
    const i = searchInteraction("q");
    await cmd.execute(i, ctx);
    expect(i.reply.mock.calls[0][0].components).toBeDefined();
  });

  test("MIN_CONFIDENT_SCORE is the RRF single-ranker ceiling 1/61", () => {
    expect(MIN_CONFIDENT_SCORE).toBeCloseTo(0.0164, 4);
    expect(2 / 85).toBeGreaterThan(MIN_CONFIDENT_SCORE); // any both-ranker hit passes
    expect(1 / 61).not.toBeGreaterThan(MIN_CONFIDENT_SCORE); // any one-ranker hit is gated
  });

  test("a ScryptError bubbles to the router (pre-reply, so the router's reply path acks)", async () => {
    const rest = {
      hybridSearch: mock(async () => {
        throw new ScryptError("scrypt_timeout", "scrypt timed out (2500ms)");
      }),
    } as any;
    const i = searchInteraction();
    await expect(buildSearchCommand(rest).execute(i, ctx)).rejects.toBeInstanceOf(ScryptError);
    expect(i.reply).not.toHaveBeenCalled();
  });
});
