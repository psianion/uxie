// para-raid module entry (v2 orchestration seam, ratified decision 12 — no longer inert).
//
// buildParaRaidModule(env) is SIDE-EFFECT FREE — no Bun.serve, no event listeners — so
// deploy-commands.ts (which only wants command definitions) never opens a port (D6).
//
// startParaRaidRuntime(mod, client, env) is called ONLY from the boot path (src/index.ts): it
// registers the MessageCreate relay and starts the webhook receiver, returning stop() for the
// shutdown path.
import { Events, type Client } from "discord.js";
import { buildCommandCollection } from "../../bot/command-loader.ts";
import type { Env } from "../../lib/env.ts";
import { log } from "../../lib/log.ts";
import { ParaRaidClient } from "./client.ts";
import { SessionCache } from "./sessions.ts";
import { buildRaidCommand } from "./commands/raid.ts";
import { startReceiver, type Receiver } from "./receiver.ts";
import { createEventHandler } from "./events.ts";
import { relayMessage } from "./relay.ts";

export interface ParaRaidModule {
  commands: ReturnType<typeof buildCommandCollection>;
  client: ParaRaidClient;
  sessions: SessionCache;
}

// Callers gate construction behind paraRaidEnabled(env) (lib/env.ts, A11); the env group is
// all-or-none, so PARARAID_SOCKET/PARARAID_ADAPTER_TOKEN/PARARAID_SIGNING_SECRET are guaranteed
// defined whenever this runs.
export function buildParaRaidModule(env: Env): ParaRaidModule {
  const client = new ParaRaidClient(env.PARARAID_SOCKET!, env.PARARAID_ADAPTER_TOKEN!);
  const sessions = new SessionCache(client);
  const commands = buildCommandCollection([buildRaidCommand(client, sessions)]);
  return { commands, client, sessions };
}

export function startParaRaidRuntime(mod: ParaRaidModule, client: Client, env: Env): { stop: () => void } {
  client.on(Events.MessageCreate, (message) => {
    void relayMessage(message, { client, api: mod.client, sessions: mod.sessions, ownerId: env.DISCORD_OWNER_ID });
  });

  let receiver: Receiver | undefined;
  const start = () => {
    receiver = startReceiver({
      port: env.PARARAID_WEBHOOK_PORT,
      secret: env.PARARAID_SIGNING_SECRET!,
      handler: createEventHandler({ client, api: mod.client, sessions: mod.sessions }),
    });
    log.info("para-raid webhook receiver started", { port: receiver.port });
  };
  // A10: ready-or-once, mirrors integrations/onboarding/index.ts.
  if (client.isReady()) start();
  else client.once(Events.ClientReady, start);

  return {
    stop: () => receiver?.stop(),
  };
}
