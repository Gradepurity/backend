import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  collectReplenishCandidates,
  sendReplenishReminder,
} from "../lib/replenishment"

/**
 * Dagelijkse voorraad-herinnering ("voorraad bijna op?"): mailt klanten van wie
 * de peptide-voorraad op basis van de doseerprofielen bijna op is, met een
 * directe herbestel-link. Selectie en spelregels (1 mail per order, alleen de
 * nieuwste order per klant, venster-begrenzing) zitten in lib/replenishment.ts.
 *
 * Uitzetten zonder deploy: REPLENISH_REMINDERS_DISABLED=1 in Railway.
 */
const MAX_PER_RUN = 20

export default async function replenishmentRemindersJob(container: MedusaContainer) {
  if (process.env.REPLENISH_REMINDERS_DISABLED === "1") return
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  const candidates = await collectReplenishCandidates(container)
  const due = candidates.filter((c) => c.status === "due")
  if (!due.length) return

  // Vangnet tegen bulk-blasts (bv. na een deploy-pauze): max 20 mails per run,
  // de rest volgt de dag erna vanzelf. Rustig tempo i.v.m. Resend-rate-limit.
  const batch = due.slice(0, MAX_PER_RUN)
  if (due.length > batch.length) {
    logger.warn(
      `replenish: ${due.length} herinneringen verschuldigd, ${batch.length} verstuurd (cap) — rest morgen.`
    )
  }

  for (const cand of batch) {
    try {
      await sendReplenishReminder(container, cand)
      logger.info(
        `replenish: herinnering -> ${cand.email} (order #${cand.displayId}: ${cand.dueItems
          .map((i) => i.handle)
          .join(", ")})`
      )
    } catch (e) {
      logger.error(
        `replenish: versturen naar ${cand.email} (order #${cand.displayId}) mislukt: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
    await new Promise((r) => setTimeout(r, 800))
  }
}

export const config = {
  name: "replenishment-reminders",
  // Dagelijks 09:00 UTC = 11:00 NL — nette tijd voor commerciële mail.
  schedule: "0 9 * * *",
}
