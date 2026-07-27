import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  collectReplenishCandidates,
  sendReplenishReminder,
} from "../lib/replenishment"

/**
 * Verstuur handmatig één voorraad-herinnering, buiten het dagelijkse schema om.
 * Werkt alleen voor orders die volgens de spelregels in aanmerking komen
 * (due of future); weigert orders die al gemaild zijn of superseded zijn.
 *   npx medusa exec ./src/scripts/send-replenish-reminder.ts <display_id>
 */
export default async function sendReplenishReminderScript({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  const displayId = Number(args?.[0])
  if (!displayId) {
    logger.error("Gebruik: medusa exec ./src/scripts/send-replenish-reminder.ts <display_id>")
    return
  }

  const candidates = await collectReplenishCandidates(container)
  const cand = candidates.find((c) => Number(c.displayId) === displayId)
  if (!cand) {
    logger.error(`Order #${displayId} niet gevonden.`)
    return
  }

  if (cand.status !== "due" && cand.status !== "future") {
    logger.error(
      `Order #${displayId} komt niet in aanmerking (status: ${cand.status}). ` +
        `Zie replenish-dryrun.ts voor het waarom.`
    )
    return
  }

  await sendReplenishReminder(container, cand)
  logger.info(
    `[replenish] herinnering -> ${cand.email} voor order #${displayId}: ${cand.dueItems
      .map((i) => `${i.quantity}× ${i.handle}`)
      .join(", ")}`
  )
}
