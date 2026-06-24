import { describe, expect, test, mock } from "bun:test";
import { Events } from "discord.js";
import { buildOnboardingModule } from "../../../src/integrations/onboarding/index.ts";

// Inline Client mock capturing event registrations.
function fakeClient(ready: boolean): any {
  const onCalls: Array<[string, (...a: any[]) => void]> = [];
  const onceCalls: Array<[string, (...a: any[]) => void]> = [];
  return {
    on: mock((event: string, cb: (...a: any[]) => void) => { onCalls.push([event, cb]); }),
    once: mock((event: string, cb: (...a: any[]) => void) => { onceCalls.push([event, cb]); }),
    isReady: () => ready,
    // channels.fetch returns null so any reconcile triggered resolves harmlessly (logs).
    channels: { fetch: mock(async () => null) },
    user: { id: "BOT_ID" },
    __onCalls: onCalls,
    __onceCalls: onceCalls,
  };
}

const env = {} as any;

describe("buildOnboardingModule", () => {
  test("registers a GuildMemberAdd listener", () => {
    const client = fakeClient(true);
    buildOnboardingModule(env, client);
    const events = client.__onCalls.map((c: any) => c[0]);
    expect(events).toContain(Events.GuildMemberAdd);
  });

  test("when client is ready, reconciles now (no ClientReady once-listener)", () => {
    const client = fakeClient(true);
    buildOnboardingModule(env, client);
    expect(client.channels.fetch).toHaveBeenCalled();
    const onceEvents = client.__onceCalls.map((c: any) => c[0]);
    expect(onceEvents).not.toContain(Events.ClientReady);
  });

  test("when client is NOT ready, schedules reconcile on ClientReady", () => {
    const client = fakeClient(false);
    buildOnboardingModule(env, client);
    const onceEvents = client.__onceCalls.map((c: any) => c[0]);
    expect(onceEvents).toContain(Events.ClientReady);
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  test("returns the two router-callable handlers", () => {
    const client = fakeClient(true);
    const handlers = buildOnboardingModule(env, client);
    expect(typeof handlers.handleRolePick).toBe("function");
    expect(typeof handlers.handleApprovalButton).toBe("function");
  });
});
