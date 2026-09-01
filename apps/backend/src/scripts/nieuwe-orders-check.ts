import { MedusaContainer } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * Read-only: laatste orders op display_id (numeriek) met betaal- + fulfillment-status.
 *   npx medusa exec ./src/scripts/nieuwe-orders-check.ts
 */
export default async function nieuweOrdersCheck({ container }: { container: MedusaContainer }) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "display_id", "created_at", "email", "status", "total", "currency_code",
      "shipping_address.country_code", "shipping_address.city",
      "payment_collections.status",
      "fulfillments.id", "fulfillments.shipped_at", "fulfillments.canceled_at",
    ],
  })

  const sorted = (orders ?? []).sort((a: any, b: any) => (b.display_id ?? 0) - (a.display_id ?? 0))

  console.log(`\n===== TOTAAL ORDERS: ${sorted.length} — laatste 12 op display_id =====`)
  for (const o of sorted.slice(0, 12)) {
    const pay = (o.payment_collections ?? []).map((p: any) => p?.status).filter(Boolean).join(",") || "geen"
    const fulfills = o.fulfillments ?? []
    const shipped = fulfills.some((f: any) => f?.shipped_at && !f?.canceled_at)
    const hasFulfill = fulfills.some((f: any) => !f?.canceled_at)
    const ship = shipped ? "VERZONDEN" : hasFulfill ? "fulfillment-aangemaakt" : "niet verzonden"
    const loc = `${o.shipping_address?.country_code?.toUpperCase() ?? "?"} ${o.shipping_address?.city ?? ""}`.trim()
    console.log(
      `#${o.display_id} | ${o.status} | betaling=${pay} | ${ship} | ${loc} | €${(o.total ?? 0)} | ${o.email} | ${o.created_at}`
    )
  }
  console.log("===== EIND =====\n")
}
