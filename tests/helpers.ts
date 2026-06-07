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
