import { mock } from "bun:test";

// Fake ChatInputCommandInteraction for router + command tests. Carries the deferred/
// replied flags the interaction-router branches on (decision 10), a deferReply that
// flips `deferred` like the real client, and an options bag with getString.
export function fakeInteraction(overrides: Record<string, unknown> = {}): any {
  return {
    id: "iid-1",
    commandName: "ping",
    user: { id: "123" },
    deferred: false,
    replied: false,
    deferReply: mock(async function (this: any) {
      this.deferred = true;
    }),
    editReply: mock(async (_: unknown) => {}),
    reply: mock(async (_: unknown) => {}),
    isChatInputCommand: () => true,
    options: {
      getString: mock((_: string, _req?: boolean) => "q"),
    },
    ...overrides,
  };
}

// Fake Message for #inbox capture tests (Wave 2). react() is mocked so the capture
// path's reaction acknowledgement is observable.
export function fakeMessage(overrides: Record<string, unknown> = {}): any {
  return {
    id: "mid-1",
    content: "hello world",
    channelId: "inbox-chan",
    author: { id: "123", bot: false },
    react: mock(async (_: string) => {}),
    ...overrides,
  };
}
