import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { cancelOrderWorkflow } from "@medusajs/medusa/core-flows"
import { buildOrderEmailData } from "../lib/order-email"

/**
 * Dagelijkse opruiming van verlopen vooruitbetalingen (eigenaarsbesluit 31-07):
 * orders die na GRACE_DAYS dagen nog geen gecapturede betaling hebben, worden
 * geannuleerd zodat de gereserveerde voorraad terug in de verkoop valt. De
 * klant krijgt een nette mail (order-auto-canceled) met de uitnodiging om
 * opnieuw te bestellen, en het verzoek te reageren als hij tóch betaald heeft.
 *
 * Let op (QR-risico): een BANKpay-QR-betaling komt op Finom binnen zonder dat
 * de BANKpay-status verandert. Zo'n order wordt handmatig gecaptured zodra de
 * Finom-mail binnenkomt; gebeurt dat binnen de termijn niet, dan vangt de
 * "toch betaald?"-regel in de klantmail dit op.
 *
 * Uitzetten zonder deploy: CANCEL_STALE_UNPAID_DISABLED=1 in Railway.
 * Termijn aanpassen: CANCEL_STALE_UNPAID_DAYS (default 7).
 */
const MAX_PER_RUN = 20

export default async function cancelStaleUnpaidJob(container: MedusaContainer) {
  if (process.env.CANCEL_STALE_UNPAID_DISABLED === "1") return
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const graceDays = Number(process.env.CANCEL_STALE_UNPAID_DAYS ?? 7)
  const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000)

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "email",
      "status",
      "created_at",
      "payment_collections.payments.captured_at",
      "fulfillments.shipped_at",
      "fulfillments.canceled_at",
    ],
    filters: { status: "pending" } as any,
  })

  const stale = (orders as any[])
    .filter((o) => o.status === "pending")
    .filter((o) => new Date(o.created_at) < cutoff)
    .filter(
      (o) =>
        !(o.payment_collections ?? [])
          .flatMap((pc: any) => pc.payments ?? [])
          .some((p: any) => p.captured_at)
    )
    .filter((o) => !(o.fulfillments ?? []).some((f: any) => !f.canceled_at && f.shipped_at))
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(0, MAX_PER_RUN)

  if (!stale.length) return
  logger.info(
    `cancel-stale-unpaid: ${stale.length} onbetaalde order(s) ouder dan ${graceDays} dagen — annuleren.`
  )

  const notifications = container.resolve(Modules.NOTIFICATION)

  for (const order of stale) {
    try {
      // Mail-data vóór het annuleren opbouwen: sommige velden zijn na een
      // cancel niet meer betrouwbaar op te vragen.
      const payload = await buildOrderEmailData(container, order.id)

      await cancelOrderWorkflow(container).run({ input: { order_id: order.id } })
      logger.info(
        `cancel-stale-unpaid: order #${order.display_id} (${order.email}) geannuleerd (besteld ${order.created_at}).`
      )

      if (payload) {
        await notifications.createNotifications({
          to: payload.email,
          channel: "email",
          template: "order-auto-canceled",
          data: payload.data as unknown as Record<string, unknown>,
        })
        logger.info(`cancel-stale-unpaid: annuleringsmail -> ${payload.email} (#${order.display_id})`)
      } else {
        logger.warn(`cancel-stale-unpaid: geen maildata voor #${order.display_id}, mail overgeslagen.`)
      }
    } catch (e) {
      logger.error(
        `cancel-stale-unpaid: order #${order.display_id} annuleren mislukt: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
    // Rustig tempo i.v.m. Resend-rate-limit.
    await new Promise((r) => setTimeout(r, 800))
  }
}

export const config = {
  name: "cancel-stale-unpaid",
  // Dagelijks 07:30 UTC = 09:30 NL, vóór de replenish-mails van 09:00 UTC.
  schedule: "30 7 * * *",
}
