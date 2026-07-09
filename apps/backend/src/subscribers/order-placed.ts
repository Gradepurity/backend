import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"
import { buildOrderEmailData } from "../lib/order-email"

/**
 * Bestelling geplaatst -> "We hebben je bestelling ontvangen" (in afwachting
 * van betaling), met bankgegevens bij een overschrijving.
 *
 * Wallid-orders ontstaan pas NA een geslaagde betaling; die klant krijgt hier
 * direct de "betaling ontvangen"-bevestiging (de payment-captured-subscriber
 * slaat wallid over, zodat er nooit een dubbele of "in afwachting"-mail komt).
 */
export default async function orderPlacedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve("logger")
  try {
    const payload = await buildOrderEmailData(container, data.id)
    if (!payload) return

    const template =
      payload.data.payment_method === "wallid" ? "payment-captured" : "order-placed"

    const notificationModuleService = container.resolve(Modules.NOTIFICATION)
    await notificationModuleService.createNotifications({
      to: payload.email,
      channel: "email",
      template,
      data: payload.data as unknown as Record<string, unknown>,
    })
  } catch (e: any) {
    // E-mail mag het plaatsen van de order nooit breken: loggen, niet rethrowen.
    logger.error(`order-placed mail mislukt voor order ${data.id}: ${e?.message}`)
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
}
