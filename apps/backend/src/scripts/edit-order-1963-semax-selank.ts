import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  beginOrderEditOrderWorkflow,
  cancelBeginOrderEditWorkflow,
  confirmOrderEditRequestWorkflow,
  orderEditAddNewItemWorkflow,
  orderEditUpdateItemQuantityWorkflow,
} from "@medusajs/medusa/core-flows"

/**
 * Eenmalige order-edit voor #1963: Semax 5 mg × 1 vervangen door
 * Selank 5 mg × 1 à € 19,95, conform de mail-afspraak met de klant
 * (30-07). Beide € 19,95, totaal blijft € 129,85.
 *
 *   npx medusa exec ./src/scripts/edit-order-1963-semax-selank.ts
 */

const DISPLAY_ID = 1963

export default async function editOrder1963({ container }: ExecArgs) {
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
  const semaxItem = (order.items ?? []).find((i: any) => /semax/i.test(i.title ?? ""))
  if (!semaxItem) {
    logger.error(`Geen Semax-regel gevonden op order #${DISPLAY_ID}`)
    return
  }
  logger.info(
    `Order ${order.id}: vervangt regel "${semaxItem.title}" × ${semaxItem.quantity} (item ${semaxItem.id})`
  )

  // 2. Variant-id van Selank 5 mg vial.
  const { data: products } = await query.graph({
    entity: "product",
    fields: ["handle", "variants.id", "variants.title"],
    filters: { handle: ["selank"] },
  })
  const selankVariant = products?.[0]?.variants?.find((v: any) =>
    v.title?.toLowerCase().includes("5 mg")
  )
  if (!selankVariant) {
    logger.error("Variant '5 mg vial' niet gevonden op selank")
    return
  }

  // 3. Order-edit: begin -> Semax-regel naar 0 -> Selank toevoegen -> bevestigen.
  await beginOrderEditOrderWorkflow(container).run({
    input: {
      order_id: order.id,
      internal_note: "Ruil Semax 5 mg -> Selank 5 mg (verzoek klant per mail 30-07, akkoord bevestigd; zelfde prijs)",
    },
  })

  try {
    await orderEditUpdateItemQuantityWorkflow(container).run({
      input: { order_id: order.id, items: [{ id: semaxItem.id, quantity: 0 }] },
    })
    logger.info("Semax-regel op 0 gezet (wordt verwijderd, reservering vervalt)")

    await orderEditAddNewItemWorkflow(container).run({
      input: {
        order_id: order.id,
        items: [{ variant_id: selankVariant.id, quantity: 1, unit_price: 19.95 }],
      },
    })
    logger.info("Nieuwe regel toegevoegd: Selank 5 mg × 1 à € 19,95")

    const { result: preview } = await confirmOrderEditRequestWorkflow(container).run({
      input: { order_id: order.id, confirmed_by: "edit-order-1963-script" },
    })
    logger.info(`Order-edit bevestigd. Nieuw totaal volgens preview: ${(preview as any)?.total}`)
  } catch (e) {
    logger.error(`Order-edit mislukt, wordt geannuleerd: ${(e as Error).message}`)
    await cancelBeginOrderEditWorkflow(container).run({ input: { order_id: order.id } })
    throw e
  }

  // 4. Verificatie: regels en totaal na de edit.
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
}
