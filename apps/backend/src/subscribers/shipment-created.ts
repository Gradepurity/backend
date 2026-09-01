import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { buildOrderEmailData } from "../lib/order-email"

/**
 * Zending aangemaakt -> "Je bestelling is onderweg" met track & trace.
 * De tracking-nummers/urls komen uit de fulfillment-labels.
 */
export default async function shipmentCreatedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve("logger")
  // Silent-modus: markeer wel als verzonden, maar stuur geen "onderweg"-mail.
  // Gebruikt voor orders die fysiek al buiten de shop verstuurd zijn.
  if (process.env.SHIP_SILENT === "1") {
    logger.info(`shipment-created: SHIP_SILENT=1 -> mail overgeslagen voor fulfillment ${data.id}`)
    return
  }
  try {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    const { data: fulfillments } = await query.graph({
      entity: "fulfillment",
      fields: [
        "id",
        "labels.tracking_number",
        "labels.tracking_url",
        "order.id",
      ],
      filters: { id: data.id },
    })

    const fulfillment = fulfillments?.[0]
    const orderId: string | undefined = fulfillment?.order?.id
    if (!orderId) {
      logger.warn(`shipment-created: geen order gevonden voor fulfillment ${data.id}`)
      return
    }

    const payload = await buildOrderEmailData(container, orderId)
    if (!payload) return

    const labels = (fulfillment.labels ?? []) as Array<{
      tracking_number?: string
      tracking_url?: string
    }>
    const trackingNumbers = labels
      .map((l) => l.tracking_number)
      .filter((n): n is string => !!n)
    const trackingUrl = labels.find((l) => l.tracking_url)?.tracking_url ?? null

    const notificationModuleService = container.resolve(Modules.NOTIFICATION)
    await notificationModuleService.createNotifications({
      to: payload.email,
      channel: "email",
      template: "order-shipped",
      data: {
        ...payload.data,
        tracking_numbers: trackingNumbers,
        tracking_url: trackingUrl,
      } as unknown as Record<string, unknown>,
    })
  } catch (e: any) {
    logger.error(`shipment-created mail mislukt voor fulfillment ${data.id}: ${e?.message}`)
  }
}

export const config: SubscriberConfig = {
  event: "shipment.created",
}
