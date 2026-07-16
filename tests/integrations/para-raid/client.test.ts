// ParaRaidClient request shaping over the daemon's unix socket. Same fetch-stubbing
// convention as tests/integrations/scrypt/rest-client.test.ts: swap globalThis.fetch,
// capture url + init, restore in finally.
import { describe, expect, test } from "bun:test";
import { ParaRaidClient, type Session } from "../../../src/integrations/para-raid/client.ts";

const SOCKET = "/tmp/para-raid.sock";
const TOKEN = "adapter-token";

interface Captured {
  url: string;
  init: (RequestInit & { unix?: string }) | undefined;
}

function withFetch(respond: () => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    return respond();
  }) as unknown as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function client() {
  return new ParaRaidClient(SOCKET, TOKEN);
}

const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200 });

describe("ParaRaidClient — POST request shaping", () => {
  const posts: Array<{ name: string; call: (c: ParaRaidClient) => Promise<unknown>; path: string; body: unknown }> = [
    {
      name: "openSession",
      call: (c) => c.openSession({ adapter_ref: "t1", prompt: "hi", bundle_name: "b" }),
      path: "/v1/open_session",
      body: { adapter_ref: "t1", prompt: "hi", bundle_name: "b" },
    },
    {
      name: "sendTurn",
      call: (c) => c.sendTurn({ session_id: "s1", prompt: "go" }),
      path: "/v1/send_turn",
      body: { session_id: "s1", prompt: "go" },
    },
    {
      name: "closeSession",
      call: (c) => c.closeSession({ session_id: "s1" }),
      path: "/v1/close_session",
      body: { session_id: "s1" },
    },
    {
      name: "resumeSession",
      call: (c) => c.resumeSession({ session_id: "s1" }),
      path: "/v1/resume_session",
      body: { session_id: "s1" },
    },
  ];

  for (const p of posts) {
    test(`${p.name} POSTs ${p.path} over the unix socket with bearer auth + idempotency key`, async () => {
      const { calls, restore } = withFetch(() => ok());
      try {
        await p.call(client());
        expect(calls).toHaveLength(1);
        const { url, init } = calls[0]!;
        expect(url).toBe(`http://para-raid${p.path}`);
        expect(init?.method).toBe("POST");
        expect(init?.unix).toBe(SOCKET);
        const headers = init?.headers as Record<string, string>;
        expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
        expect(headers["Content-Type"]).toBe("application/json");
        expect(headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
        expect(JSON.parse(String(init?.body))).toEqual(p.body);
        expect(init?.signal).toBeInstanceOf(AbortSignal);
      } finally {
        restore();
      }
    });
  }

  test("every POST carries a FRESH Idempotency-Key (retries of a new call are new operations)", async () => {
    const { calls, restore } = withFetch(() => ok());
    try {
      const c = client();
      await c.sendTurn({ session_id: "s1", prompt: "a" });
      await c.sendTurn({ session_id: "s1", prompt: "b" });
      const key = (i: number) => (calls[i]!.init?.headers as Record<string, string>)["Idempotency-Key"];
      expect(key(0)).not.toBe(key(1));
    } finally {
      restore();
    }
  });

  test("openSession without a bundle omits bundle_name from the body", async () => {
    const { calls, restore } = withFetch(() => ok());
    try {
      await client().openSession({ adapter_ref: "t1", prompt: "hi" });
      expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ adapter_ref: "t1", prompt: "hi" });
    } finally {
      restore();
    }
  });
});

describe("ParaRaidClient — GET /v1/sessions", () => {
  test("listSessions GETs /v1/sessions with bearer auth, no body, NO Idempotency-Key", async () => {
    const { calls, restore } = withFetch(() => ok({ sessions: [], next_cursor: null }));
    try {
      await client().listSessions();
      const { url, init } = calls[0]!;
      expect(url).toBe("http://para-raid/v1/sessions");
      expect(init?.method).toBe("GET");
      expect(init?.unix).toBe(SOCKET);
      const headers = init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
      expect(headers["Idempotency-Key"]).toBeUndefined();
      expect(headers["Content-Type"]).toBeUndefined();
      expect(init?.body).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("listSessions parses the sessions payload", async () => {
    const session: Session = {
      id: "s1",
      adapter_id: "a1",
      adapter_ref: "thread-1",
      status: "live",
      tmux_session: "tmux-1",
      cwd: "/work",
      created_at: 1,
      updated_at: 2,
      last_turn_at: null,
      recovery_expires_at: null,
    };
    const { restore } = withFetch(() => ok({ sessions: [session], next_cursor: null }));
    try {
      const res = await client().listSessions();
      expect(res.status).toBe(200);
      expect(res.body.sessions).toEqual([session]);
      expect(res.body.next_cursor).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("ParaRaidClient — errors and timeout", () => {
  test("non-2xx status is surfaced (not thrown) with the parsed error body", async () => {
    const { restore } = withFetch(
      () => new Response(JSON.stringify({ error: "session_not_live" }), { status: 404 }),
    );
    try {
      const res = await client().sendTurn({ session_id: "gone", prompt: "x" });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("session_not_live");
    } finally {
      restore();
    }
  });

  test("an empty response body parses to {}", async () => {
    const { restore } = withFetch(() => new Response("", { status: 200 }));
    try {
      const res = await client().closeSession({ session_id: "s1" });
      expect(res.status).toBe(200);
      expect(res.body as Record<string, unknown>).toEqual({});
    } finally {
      restore();
    }
  });

  test("a fetch rejection (daemon unreachable / abort) propagates to the caller", async () => {
    const { restore } = withFetch(() => {
      throw new TypeError("unable to connect");
    });
    try {
      await expect(client().listSessions()).rejects.toThrow("unable to connect");
    } finally {
      restore();
    }
  });

  test("every call is bounded by an unaborted-at-issue AbortSignal (the 5s daemon-wedge guard)", async () => {
    // Behavior contract: the request carries a timeout signal so a wedged daemon aborts the
    // fetch instead of hanging forever. We assert the signal is present and not pre-aborted;
    // actually waiting out the 5s belongs to Bun's AbortSignal.timeout, not to us.
    const { calls, restore } = withFetch(() => ok());
    try {
      await client().listSessions();
      const signal = calls[0]!.init?.signal as AbortSignal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
    } finally {
      restore();
    }
  });
});
