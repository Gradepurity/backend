import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { buildOrderEmailData } from "../lib/order-email"

/**
 * Betaling vastgelegd -> "Betaling ontvangen, bestelling bevestigd".
 * Voor bank/crypto komt dit los na de order.placed-mail, zodra het geld binnen is.
 */
export default async function paymentCapturedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve("logger")
  try {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    // Van payment -> order id via de payment_collection-link.
    const { data: payments } = await query.graph({
      entity: "payment",
      fields: ["id", "payment_collection.order.id"],
      filters: { id: data.id },
    })

    const orderId: string | undefined =
      payments?.[0]?.payment_collection?.order?.id
    if (!orderId) {
      logger.warn(`payment-captured: geen order gevonden voor payment ${data.id}`)
      return
    }

    const payload = await buildOrderEmailData(container, orderId)
    if (!payload) return

    // Wallid: de order-placed-subscriber stuurt al de "betaling ontvangen"-mail
    // (betaling en order ontstaan daar in één keer) — hier overslaan voorkomt
    // een dubbele mail.
    if (payload.data.payment_method === "wallid") return

    const notificationModuleService = container.resolve(Modules.NOTIFICATION)
    await notificationModuleService.createNotifications({
      to: payload.email,
      channel: "email",
      template: "payment-captured",
      data: payload.data as unknown as Record<string, unknown>,
    })
  } catch (e: any) {
    logger.error(`payment-captured mail mislukt voor payment ${data.id}: ${e?.message}`)
  }
}

export const config: SubscriberConfig = {
  event: "payment.captured",
}
