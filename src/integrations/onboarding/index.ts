// Onboarding module: wires the event-driven onboarding flow and exposes the two
// router-callable button handlers. Contributes NO slash commands (it is event-driven).
//
// Registers:
//   - Events.GuildMemberAdd -> onMemberJoin (assigns the guest role; never throws out).
//   - the welcome-message reconcile, scheduled now if the client is already ready, else on
//     the next Events.ClientReady. reconcileWelcomeMessage catches its own failures.
//
// Returns OnboardingHandlers — the thin wrappers the interaction-router calls. The router
// never imports the inner handler files directly; it goes through this object. `env` is
// accepted for signature symmetry with the other build*Module factories; ownerId flows from
// the router (not from env here), matching the spec's handleApprovalButton(i, ownerId) shape.
import { Events } from "discord.js";
import type { ButtonInteraction, Client } from "discord.js";
import type { Env } from "../../lib/env.ts";
import { guildConfig } from "../../config/guild.ts";
import { onMemberJoin } from "./member-join.ts";
import { reconcileWelcomeMessage } from "./welcome-message.ts";
import { handleRolePick } from "./role-pick-handler.ts";
import { handleApprovalButton } from "./approval-handler.ts";

export type OnboardingHandlers = {
  handleRolePick: (i: ButtonInteraction) => Promise<void>;
  handleApprovalButton: (i: ButtonInteraction, ownerId: string) => Promise<void>;
};

export function buildOnboardingModule(_env: Env, client: Client): OnboardingHandlers {
  client.on(Events.GuildMemberAdd, (member) => {
    // onMemberJoin never throws (its internal catch covers failures); void the promise.
    void onMemberJoin(member, guildConfig.guestRoleId);
  });

  if (client.isReady()) {
    void reconcileWelcomeMessage(client);
  } else {
    client.once(Events.ClientReady, () => {
      void reconcileWelcomeMessage(client);
    });
  }

  return {
    handleRolePick: (i) => handleRolePick(i),
    handleApprovalButton: (i, ownerId) => handleApprovalButton(i, ownerId),
  };
}
