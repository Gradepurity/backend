import { MedusaContainer } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * READ-ONLY: alle orders met gratis cadeaus (metadata.gifts), met status en
 * verzendstatus — om te controleren of cadeaus bij het inpakken zijn meegegaan.
 *   npx medusa exec ./src/scripts/orders-met-cadeaus.ts
 */
export default async function ordersMetCadeaus({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "display_id",
      "status",
      "created_at",
      "email",
      "metadata",
      "fulfillments.shipped_at",
      "fulfillments.canceled_at",
    ],
    pagination: { take: 5000, skip: 0 } as any,
  })

  const rows = (orders as any[])
    .filter((o) => o.metadata?.gifts && String(o.metadata.gifts).trim() !== "")
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

  const dag = (d: any) =>
    new Date(d).toLocaleDateString("nl-NL", { timeZone: "Europe/Amsterdam", day: "2-digit", month: "2-digit" })

  logger.info(`\n===== ORDERS MET CADEAUS: ${rows.length} =====`)
  for (const o of rows) {
    const shipped = (o.fulfillments ?? []).some((f: any) => f.shipped_at && !f.canceled_at)
    logger.info(
      `#${o.display_id} | ${dag(o.created_at)} | ${o.email} | status=${o.status} | ` +
        `${shipped ? "VERZONDEN" : "niet verzonden"} | cadeaus: ${o.metadata.gifts}`
    )
  }
  logger.info(`===== EIND =====\n`)
}
