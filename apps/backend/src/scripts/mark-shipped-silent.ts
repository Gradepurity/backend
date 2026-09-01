import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  createOrderFulfillmentWorkflow,
  createOrderShipmentWorkflow,
} from "@medusajs/medusa/core-flows"

/**
 * Markeer een order als verzonden ZONDER track&trace en ZONDER mail.
 * Voor orders die fysiek al buiten het systeem om verstuurd zijn en waarvan
 * we alleen de administratie kloppend willen maken.
 * Draai met SHIP_SILENT=1 zodat de shipment-created-subscriber geen mail stuurt.
 *   SHIP_SILENT=1 npx medusa exec ./src/scripts/mark-shipped-silent.ts <display_id> [<display_id> ...]
 */
export default async function markShippedSilent({ container, args }: ExecArgs) {
  const logger = container.resolve("logger")
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const ids = (args ?? []).map((a) => Number(a)).filter((n) => Number.isFinite(n) && n > 0)
  if (!ids.length) {
    logger.error("Gebruik: SHIP_SILENT=1 medusa exec ./src/scripts/mark-shipped-silent.ts <display_id> [...]")
    return
  }
  if (process.env.SHIP_SILENT !== "1") {
    logger.warn("LET OP: SHIP_SILENT is niet '1' -> de shipment-created-subscriber zal alsnog mail sturen. Afgebroken.")
    return
  }

  for (const displayId of ids) {
    const { data: orders } = await query.graph({
      entity: "order",
      fields: [
        "id", "display_id", "email",
        "items.id", "items.detail.quantity", "items.quantity", "items.title",
        "fulfillments.id", "fulfillments.shipped_at", "fulfillments.canceled_at",
      ],
      filters: { display_id: displayId as unknown as string },
    })

    const order = (orders as any[])[0]
    if (!order) {
      logger.error(`Order #${displayId} niet gevonden — overslaan`)
      continue
    }

    const items = (order.items ?? []).map((i: any) => ({
      id: i.id,
      quantity: Number(i.detail?.quantity ?? i.quantity),
    }))
    if (items.some((i: any) => !Number.isFinite(i.quantity) || i.quantity <= 0)) {
      logger.error(`Order #${displayId}: item-aantallen onbepaald: ${JSON.stringify(items)} — overslaan`)
      continue
    }

    let fulfillment = (order.fulfillments ?? []).find((f: any) => !f.canceled_at)
    if (fulfillment?.shipped_at) {
      logger.info(`Order #${displayId}: al verzonden (${fulfillment.shipped_at}) — overslaan`)
      continue
    }

    if (!fulfillment) {
      logger.info(`Order #${displayId} (${order.email}): fulfillment aanmaken…`)
      const { result } = await createOrderFulfillmentWorkflow(container).run({
        input: { order_id: order.id, items },
      })
      fulfillment = result
    }

    logger.info(`Order #${displayId}: shipment registreren (geen T&T, geen mail)…`)
    await createOrderShipmentWorkflow(container).run({
      input: {
        order_id: order.id,
        fulfillment_id: fulfillment.id,
        items,
        labels: [],
      },
    })
    logger.info(`Order #${displayId}: verzonden gemarkeerd (silent).`)
  }

  logger.info("Klaar.")
}
