// Module entry: buildParaRaidModule must stay side-effect free (D6 — deploy-commands.ts
// imports it without opening ports), and startParaRaidRuntime owns the relay + receiver
// lifecycle. Fake Discord client is the usual plain object with mock listeners.
import { describe, expect, mock, test } from "bun:test";
import { Events } from "discord.js";
import { buildParaRaidModule, startParaRaidRuntime } from "../../../src/integrations/para-raid/index.ts";
import { ParaRaidClient } from "../../../src/integrations/para-raid/client.ts";
import { SessionCache } from "../../../src/integrations/para-raid/sessions.ts";
import type { Env } from "../../../src/lib/env.ts";
import { setLogSink, type LogEntry } from "../../../src/lib/log.ts";

function fakeEnv(port: number): Env {
  return {
    DISCORD_OWNER_ID: "owner-1",
    PARARAID_SOCKET: "/tmp/para-raid-test.sock",
    PARARAID_ADAPTER_TOKEN: "tok",
    PARARAID_SIGNING_SECRET: "sec",
    PARARAID_WEBHOOK_PORT: port,
  } as unknown as Env;
}

function fakeDiscordClient(ready: boolean): any {
  return {
    isReady: () => ready,
    on: mock((_evt: string, _fn: unknown) => {}),
    once: mock((_evt: string, _fn: unknown) => {}),
  };
}

async function withLogs<T>(fn: () => T | Promise<T>): Promise<{ result: T; logs: LogEntry[] }> {
  const logs: LogEntry[] = [];
  setLogSink((e) => logs.push(e));
  try {
    return { result: await fn(), logs };
  } finally {
    setLogSink(null);
  }
}

describe("buildParaRaidModule", () => {
  test("returns the raid command plus wired client and cache", () => {
    const mod = buildParaRaidModule(fakeEnv(18917));
    expect(mod.commands.has("raid")).toBe(true);
    expect(mod.commands.size).toBe(1);
    expect(mod.client).toBeInstanceOf(ParaRaidClient);
    expect(mod.sessions).toBeInstanceOf(SessionCache);
  });

  test("is side-effect free — building does NOT open the webhook port (D6)", async () => {
    const port = 18917;
    buildParaRaidModule(fakeEnv(port));
    // Nothing may be listening: the deploy-commands path builds modules with no runtime.
    await expect(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  });
});

describe("startParaRaidRuntime", () => {
  test("registers the MessageCreate relay and starts the receiver when the client is ready", async () => {
    const env = fakeEnv(0); // port 0: Bun picks a free port; read it back from the log
    const mod = buildParaRaidModule(env);
    const client = fakeDiscordClient(true);

    const { result: runtime, logs } = await withLogs(() => startParaRaidRuntime(mod, client, env));
    try {
      expect(client.on).toHaveBeenCalledTimes(1);
      expect(client.on.mock.calls[0]?.[0]).toBe(Events.MessageCreate);
      expect(typeof client.on.mock.calls[0]?.[1]).toBe("function");
      expect(client.once).not.toHaveBeenCalled(); // already ready — starts now, not on ClientReady

      const started = logs.find((e) => e.msg.includes("receiver started"));
      expect(started).toBeDefined();
      const port = started!.fields.port as number;
      // Proof of life: the receiver answers (404 on a wrong path is still an answer).
      const res = await fetch(`http://127.0.0.1:${port}/nope`);
      expect(res.status).toBe(404);

      runtime.stop();
      await expect(fetch(`http://127.0.0.1:${port}/nope`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    } finally {
      runtime.stop(); // idempotent safety if an assertion above threw first
    }
  });

  test("defers receiver start to ClientReady when the client is not ready yet (A10)", async () => {
    const env = fakeEnv(0);
    const mod = buildParaRaidModule(env);
    const client = fakeDiscordClient(false);

    const { result: runtime, logs } = await withLogs(() => startParaRaidRuntime(mod, client, env));
    expect(logs.find((e) => e.msg.includes("receiver started"))).toBeUndefined(); // not yet
    expect(client.once).toHaveBeenCalledTimes(1);
    expect(client.once.mock.calls[0]?.[0]).toBe(Events.ClientReady);

    // stop() before ready must be a no-op, not a crash.
    runtime.stop();

    // Now simulate ready: the registered ClientReady callback starts the receiver.
    const start = client.once.mock.calls[0]?.[1] as () => void;
    const { logs: startLogs } = await withLogs(() => start());
    const started = startLogs.find((e) => e.msg.includes("receiver started"));
    expect(started).toBeDefined();
    const port = started!.fields.port as number;
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
    runtime.stop();
    await expect(fetch(`http://127.0.0.1:${port}/nope`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  });
});
