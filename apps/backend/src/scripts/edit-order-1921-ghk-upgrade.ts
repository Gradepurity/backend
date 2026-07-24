import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  beginOrderEditOrderWorkflow,
  cancelBeginOrderEditWorkflow,
  confirmOrderEditRequestWorkflow,
  orderEditAddNewItemWorkflow,
  orderEditUpdateItemQuantityWorkflow,
  updateInventoryLevelsWorkflow,
} from "@medusajs/medusa/core-flows"

/**
 * Eenmalige order-edit voor #1921: de regel GHK-Cu 50 mg × 10 (€ 221,60)
 * vervangen door GHK-Cu 100 mg × 5 à € 44,32 + × 2 à € 0 (gratis extra),
 * conform de WhatsApp-afspraak met de klant. Totaal blijft € 365,48, dus
 * geen betalingsverschil. Zet vooraf de 100 mg-voorraad op 9 (7 voor deze
 * order + 2 losse vials), zodat de reservering past en er na verzending
 * precies 2 overblijven.
 *
 *   npx medusa exec ./src/scripts/edit-order-1921-ghk-upgrade.ts
 */

const DISPLAY_ID = 1921

export default async function editOrder1921({ container }: ExecArgs) {
  const logger = container.resolve("logger")
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  // 1. Order + de te vervangen regel opzoeken.
  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["id", "display_id", "total", "items.id", "items.title", "items.quantity", "items.unit_price"],
    filters: { display_id: DISPLAY_ID } as any,
  })
  const order = (orders as any[])[0]
  if (!order) {
    logger.error(`Order #${DISPLAY_ID} niet gevonden`)
    return
  }
  const ghkItem = (order.items ?? []).find((i: any) => /ghk/i.test(i.title ?? ""))
  if (!ghkItem) {
    logger.error(`Geen GHK-Cu-regel gevonden op order #${DISPLAY_ID}`)
    return
  }
  logger.info(
    `Order ${order.id}: vervangt regel "${ghkItem.title}" × ${ghkItem.quantity} (item ${ghkItem.id})`
  )

  // 2. Variant-id van de 100 mg vial + huidige voorraadniveaus.
  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "handle",
      "variants.id",
      "variants.title",
      "variants.inventory_items.inventory.id",
      "variants.inventory_items.inventory.location_levels.location_id",
      "variants.inventory_items.inventory.location_levels.stocked_quantity",
    ],
    filters: { handle: ["ghk-cu"] },
  })
  const variant100 = products?.[0]?.variants?.find((v: any) =>
    v.title?.toLowerCase().includes("100 mg")
  )
  if (!variant100) {
    logger.error("Variant '100 mg vial' niet gevonden op ghk-cu")
    return
  }

  // 3. 100 mg-voorraad naar 9: 7 voor deze order + 2 losse vials op de plank.
  const invUpdates = (variant100.inventory_items ?? []).flatMap((ii: any) =>
    (ii?.inventory?.location_levels ?? []).map((lvl: any) => ({
      inventory_item_id: ii.inventory.id,
      location_id: lvl.location_id,
      stocked_quantity: 9,
    }))
  )
  if (invUpdates.length) {
    await updateInventoryLevelsWorkflow(container).run({ input: { updates: invUpdates } })
    logger.info(`100 mg-voorraad op 9 gezet (7 voor #${DISPLAY_ID} + 2 losse vials)`)
  }

  // 4. Order-edit: begin -> 50 mg-regel naar 0 -> nieuwe regels -> bevestigen.
  await beginOrderEditOrderWorkflow(container).run({
    input: {
      order_id: order.id,
      internal_note: "Upgrade GHK-Cu 50 mg×10 -> 100 mg×5 + 2 gratis (voorraadtekort, akkoord klant via WhatsApp 24-07)",
    },
  })

  try {
    await orderEditUpdateItemQuantityWorkflow(container).run({
      input: { order_id: order.id, items: [{ id: ghkItem.id, quantity: 0 }] },
    })
    logger.info("50 mg-regel op 0 gezet (wordt verwijderd, reservering vervalt)")

    await orderEditAddNewItemWorkflow(container).run({
      input: {
        order_id: order.id,
        items: [
          { variant_id: variant100.id, quantity: 5, unit_price: 44.32 },
          { variant_id: variant100.id, quantity: 2, unit_price: 0, internal_note: "Gratis extra (upgrade-afspraak)" },
        ],
      },
    })
    logger.info("Nieuwe regels toegevoegd: 100 mg × 5 à € 44,32 + 100 mg × 2 à € 0")

    const { result: preview } = await confirmOrderEditRequestWorkflow(container).run({
      input: { order_id: order.id, confirmed_by: "edit-order-1921-script" },
    })
    logger.info(`Order-edit bevestigd. Nieuw totaal volgens preview: ${(preview as any)?.total}`)
  } catch (e) {
    logger.error(`Order-edit mislukt, wordt geannuleerd: ${(e as Error).message}`)
    await cancelBeginOrderEditWorkflow(container).run({ input: { order_id: order.id } })
    throw e
  }

  // 5. Verificatie: regels, totaal en voorraad na de edit.
  const { data: after } = await query.graph({
    entity: "order",
    fields: ["display_id", "total", "items.title", "items.quantity", "items.unit_price"],
    filters: { display_id: DISPLAY_ID } as any,
  })
  const a = (after as any[])[0]
  for (const i of a?.items ?? []) {
    logger.info(`  regel: ${i.title} × ${i.quantity} à ${i.unit_price}`)
  }
  logger.info(`  totaal: ${a?.total}`)

  const { data: prodAfter } = await query.graph({
    entity: "product",
    fields: [
      "variants.title",
      "variants.inventory_items.inventory.location_levels.stocked_quantity",
      "variants.inventory_items.inventory.location_levels.reserved_quantity",
    ],
    filters: { handle: ["ghk-cu"] },
  })
  for (const v of prodAfter?.[0]?.variants ?? []) {
    for (const ii of (v as any).inventory_items ?? []) {
      for (const lvl of ii?.inventory?.location_levels ?? []) {
        logger.info(
          `  voorraad ${v.title}: stocked ${lvl.stocked_quantity}, reserved ${lvl.reserved_quantity}`
        )
      }
    }
  }
}
