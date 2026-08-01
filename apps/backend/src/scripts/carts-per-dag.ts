import { MedusaContainer } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * READ-ONLY: aantal aangemaakte carts per dag (laatste 7 dagen), met aparte
 * telling tot 12:00 (Europe/Amsterdam) om ochtenden eerlijk te vergelijken.
 *   npx medusa exec ./src/scripts/carts-per-dag.ts
 */
export default async function cartsPerDag({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: carts } = await query.graph({
    entity: "cart",
    fields: ["id", "created_at", "completed_at", "email"],
    pagination: { take: 5000, skip: 0 } as any,
  })

  const dayFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Amsterdam", dateStyle: "short" })
  const hourFmt = new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", hour12: false })

  const cutoff = Date.now() - 7 * 24 * 3600 * 1000
  const byDay = new Map<string, { total: number; ochtend: number; completed: number }>()
  for (const c of carts as any[]) {
    const t = new Date(c.created_at).getTime()
    if (t < cutoff) continue
    const day = dayFmt.format(new Date(c.created_at))
    const hour = Number(hourFmt.format(new Date(c.created_at)))
    const row = byDay.get(day) ?? { total: 0, ochtend: 0, completed: 0 }
    row.total++
    if (hour < 12) row.ochtend++
    if (c.completed_at) row.completed++
    byDay.set(day, row)
  }

  logger.info(`\n===== CARTS PER DAG (laatste 7 dagen) =====`)
  for (const [day, row] of [...byDay.entries()].sort()) {
    logger.info(`${day} | nieuw: ${row.total} (waarvan vóór 12:00: ${row.ochtend}) | afgerond: ${row.completed}`)
  }
  logger.info(`===== EIND =====\n`)
}
