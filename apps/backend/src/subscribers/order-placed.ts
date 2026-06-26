import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"
import { buildOrderEmailData } from "../lib/order-email"

/**
 * Bestelling geplaatst -> "We hebben je bestelling ontvangen" (in afwachting
 * van betaling). Bevat de juiste betaalinstructie-tekst per methode (bank/crypto).
 */
export default async function orderPlacedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve("logger")
  try {
    const payload = await buildOrderEmailData(container, data.id)
    if (!payload) return

    const notificationModuleService = container.resolve(Modules.NOTIFICATION)
    await notificationModuleService.createNotifications({
      to: payload.email,
      channel: "email",
      template: "order-placed",
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
