import { MedusaContainer } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { collectReplenishCandidates } from "../lib/replenishment"

/**
 * READ-ONLY dry-run van de voorraad-herinneringen: toont per order de status
 * (due/future/stale/sent/superseded/…), de geplande maildatum en de producten
 * die in de mail zouden komen. Verstuurt NIETS en wijzigt NIETS.
 *   npx medusa exec ./src/scripts/replenish-dryrun.ts
 */
export default async function replenishDryrun({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  const candidates = await collectReplenishCandidates(container)

  const dag = (d: Date | null) =>
    d
      ? d.toLocaleString("nl-NL", {
          timeZone: "Europe/Amsterdam",
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "-"

  const perStatus = new Map<string, typeof candidates>()
  for (const c of candidates) {
    const list = perStatus.get(c.status) ?? []
    list.push(c)
    perStatus.set(c.status, list)
  }

  logger.info(
    `\n===== VOORRAAD-HERINNERING DRY-RUN (${candidates.length} orders) =====\n` +
      [...perStatus.entries()].map(([s, l]) => `${s}: ${l.length}`).join(" | ")
  )

  // Interessantste eerst: wat gaat er (bijna) uit, wat is overgeslagen en waarom.
  const volgorde = ["due", "future", "stale", "sent", "superseded", "opted-out", "not-shipped", "no-peptides"]
  for (const status of volgorde) {
    const list = perStatus.get(status as any) ?? []
    if (!list.length) continue
    logger.info(`\n----- ${status.toUpperCase()} (${list.length}) -----`)
    for (const c of list.sort((a, b) => (a.sendAt?.getTime() ?? 0) - (b.sendAt?.getTime() ?? 0))) {
      const items = (c.status === "due" || c.status === "future" ? c.dueItems : c.items)
        .map((i) => `${i.quantity}× ${i.handle} (${i.variant ?? "?"}, dag ${i.reminderDays})`)
        .join("; ")
      logger.info(
        `#${c.displayId} | ${c.email} | ${c.locale} | verzonden ${dag(c.shippedAt)} | mail ${dag(c.sendAt)}` +
          (items ? `\n      ${items}` : "")
      )
    }
  }

  logger.info(`\n===== EIND (niets verstuurd) =====\n`)
}
