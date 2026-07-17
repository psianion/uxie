import { describe, expect, test, mock } from "bun:test";
import { ChannelType } from "discord.js";
import { buildTriageCommand } from "../../../src/integrations/triage/command.ts";
import { ParaRaidError } from "../../../src/lib/errors.ts";

const ctx = { clientTag: "uxie-x", log: { info() {}, warn() {}, error() {} } as any };
const OPTS = { triageChannelId: "999", bundle: "scrypt" };

function triageInteraction(opts: { content?: string; openStatus?: number } = {}): any {
  const threadSend = mock(async (_: unknown) => ({}));
  const thread = { id: "t1", send: threadSend };
  const channel = {
    id: "999",
    type: ChannelType.GuildText,
    threads: { create: mock(async (_: unknown) => thread) },
  };
  return {
    commandName: "Triage",
    targetMessage: {
      content: opts.content ?? "look at https://blog.example/post",
      attachments: new Map(),
      embeds: [],
      url: "https://discord.com/channels/1/2/3",
      channelId: "chan-src",
      author: { tag: "psianion" },
    },
    client: { channels: { fetch: mock(async () => channel) } },
    editReply: mock(async (_: unknown) => {}),
    __channel: channel,
    __threadSend: threadSend,
  };
}

function apiStub(status = 202) {
  return {
    openSession: mock(async (_: unknown) => ({ status, body: { session_id: "s1", status: "launching" } })),
  } as any;
}

describe("Triage message command", () => {
  test("builder: message-type context menu, owner-locked", () => {
    const cmd = buildTriageCommand(apiStub(), OPTS);
    const json = cmd.data.toJSON() as any;
    expect(json.name).toBe("Triage");
    expect(json.type).toBe(3); // ApplicationCommandType.Message
    expect(json.default_member_permissions).toBe("0");
  });

  test("creates thread, posts source card, opens session with bundle + thread adapter_ref", async () => {
    const api = apiStub();
    const cmd = buildTriageCommand(api, OPTS);
    const i = triageInteraction();
    await cmd.execute(i, ctx);

    const created = i.__channel.threads.create.mock.calls[0][0];
    expect(created.name).toBe("triage: blog.example");

    const card = i.__threadSend.mock.calls[0][0] as string;
    expect(card).toContain("psianion");
    expect(card).toContain("https://blog.example/post");
    expect(card).toContain("<#chan-src>");

    const open = api.openSession.mock.calls[0][0];
    expect(open.adapter_ref).toBe("t1");
    expect(open.bundle_name).toBe("scrypt");
    expect(open.prompt).toContain("https://blog.example/post");
    expect(open.prompt).toContain("STOP and wait");

    expect(i.editReply).toHaveBeenCalledWith("triaged → <#t1>");
  });

  test("message with no links/attachments throws", async () => {
    const cmd = buildTriageCommand(apiStub(), OPTS);
    const i = triageInteraction({ content: "no links here" });
    expect(cmd.execute(i, ctx)).rejects.toThrow(ParaRaidError);
  });

  test("open_session failure surfaces as ParaRaidError", async () => {
    const cmd = buildTriageCommand(apiStub(500), OPTS);
    const i = triageInteraction();
    expect(cmd.execute(i, ctx)).rejects.toThrow("open_session failed (500)");
  });
});
