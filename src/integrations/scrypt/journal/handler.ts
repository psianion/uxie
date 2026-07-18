// Owner+guild gating already happened in the router; this just dispatches journal:day:<date>
// button clicks. Each fetches that day's bundle and updates the same ephemeral V2 message in
// place. No try/catch — the router is the single button catch site (decision 10).
import type { ComponentHandler } from "../../../bot/interaction-router.ts";
import type { ScryptRestClient } from "../rest-client.ts";
import { buildStatusContainer } from "../../../lib/ui/status-container.ts";
import { journalDayModel } from "./panel.ts";

export function buildJournalComponentHandler(rest: ScryptRestClient): ComponentHandler {
  return {
    namespace: "journal",
    async handle(i) {
      const date = i.customId.split(":")[2] ?? "";
      const bundle = await rest.journalDay(date);
      await i.update({ components: [buildStatusContainer(journalDayModel(bundle))] });
    },
  };
}
