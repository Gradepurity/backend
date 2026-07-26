import { MedusaContainer } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * READ-ONLY: voorraaddetail GHK-Cu — stocked/reserved per variant + alle open
 * reserveringen met timestamps, om te reconstrueren wanneer de voorraad op
 * 0/negatief kwam en welke orders er nog tegenaan hangen.
 *   npx medusa exec ./src/scripts/ghk-inventory-detail.ts
 */
export default async function ghkInventoryDetail({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "handle",
      "variants.id",
      "variants.title",
      "variants.inventory_items.inventory.id",
      "variants.inventory_items.inventory.sku",
    ],
    filters: { handle: "ghk-cu" },
  })

  const inventoryModule = container.resolve(Modules.INVENTORY)

  for (const p of products as any[]) {
    for (const v of p.variants ?? []) {
      logger.info(`\n===== ${p.handle} / ${v.title} =====`)
      for (const ii of v.inventory_items ?? []) {
        const invId = ii.inventory?.id
        if (!invId) continue
        const levels = await inventoryModule.listInventoryLevels({ inventory_item_id: invId })
        for (const l of levels) {
          logger.info(
            `  locatie ${l.location_id}: stocked=${l.stocked_quantity}, reserved=${l.reserved_quantity}, incoming=${l.incoming_quantity}` +
              ` | level updated_at=${new Date(l.updated_at as any).toISOString()}`
          )
        }
        const reservations = await inventoryModule.listReservationItems({ inventory_item_id: invId })
        for (const r of reservations) {
          logger.info(
            `  reservering ${r.id}: qty=${r.quantity}, line_item=${r.line_item_id}, aangemaakt=${new Date(r.created_at as any).toISOString()}`
          )
        }
        if (!reservations.length) logger.info(`  (geen open reserveringen)`)
      }
    }
  }
  logger.info(`\n===== EIND =====`)
}
