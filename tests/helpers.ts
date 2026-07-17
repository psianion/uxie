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
    isButton: () => false,
    isMessageContextMenuCommand: () => false,
    options: {
      getString: mock((_: string, _req?: boolean) => "q"),
    },
    ...overrides,
  };
}

// Fake MessageContextMenuCommandInteraction for router/message-command tests.
export function fakeMessageCommandInteraction(overrides: Record<string, unknown> = {}): any {
  return {
    id: "mid-1",
    commandName: "Triage",
    user: { id: "123" },
    deferred: false,
    replied: false,
    deferReply: mock(async function (this: any) {
      this.deferred = true;
    }),
    editReply: mock(async (_: unknown) => {}),
    reply: mock(async (_: unknown) => {}),
    isChatInputCommand: () => false,
    isButton: () => false,
    isMessageContextMenuCommand: () => true,
    targetMessage: { content: "", attachments: new Map(), embeds: [] },
    ...overrides,
  };
}

// Fake ButtonInteraction for router/component tests.
export function fakeButton(over: Record<string, unknown> = {}): any {
  return {
    id: "bid-1",
    customId: "ping:refresh",
    user: { id: "123" },
    guildId: "guild-1",
    isChatInputCommand: () => false,
    isButton: () => true,
    update: mock(async (_: unknown) => {}),
    deferUpdate: mock(async () => {}),
    editReply: mock(async (_: unknown) => {}),
    reply: mock(async (_: unknown) => {}),
    client: { ws: { ping: 42 } },
    ...over,
  };
}
