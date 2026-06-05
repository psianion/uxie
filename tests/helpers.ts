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

// Fake Message for router + mention tests. Defaults match a valid owner message. Pass
// `mentionsBot: true` to make `mentions.has(...)` return true, and `clientUserId` to set the
// bot's own id. `react` and `reply` are mocked so handler acknowledgements are observable.
export function fakeMessage(overrides: Record<string, unknown> = {}): any {
  const { mentionsBot = false, clientUserId = "bot-1", ...rest } = overrides as any;
  return {
    id: "mid-1",
    content: "hello world",
    channelId: "inbox-chan",
    author: { id: "123", bot: false },
    client: { user: { id: clientUserId } },
    mentions: { has: mock((_id: string, _opts?: unknown) => mentionsBot) },
    react: mock(async (_: string) => {}),
    reply: mock(async (_: unknown) => ({ delete: mock(async () => {}) })),
    ...rest,
  };
}
