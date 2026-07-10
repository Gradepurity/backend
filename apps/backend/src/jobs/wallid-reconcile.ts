import { MedusaContainer } from "@medusajs/framework/types"
import {
  BigNumber,
  ContainerRegistrationKeys,
  PaymentActions,
} from "@medusajs/framework/utils"
import { processPaymentWorkflow } from "@medusajs/medusa/core-flows"
import { WallidClient } from "../modules/wallid/lib/client"

/**
 * Vangnet voor Wallid-betalingen: rondt carts af waarvan de betaling bij
 * Wallid geslaagd is maar de order nooit ontstond — bv. omdat de klant na het
 * betalen (QR op de telefoon) nooit op de retourpagina landde en de webhook
 * (nog) niet geregistreerd is. Ordercreatie mag nooit afhangen van de browser
 * van de klant; deze job maakt 'm hoe dan ook binnen ~5 minuten aan.
 *
 * Idempotent: processPaymentWorkflow slaat afgeronde carts/orders over, en
 * carts met een al-afgeronde status filteren we hier vooraf uit.
 */
const LOOKBACK_HOURS = 48

export default async function wallidReconcileJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  const keyId = process.env.WALLID_KEY_ID
  const keySecret = process.env.WALLID_KEY_SECRET
  if (!keyId || !keySecret) {
    return // Wallid niet geconfigureerd — niets te doen.
  }

  const client = new WallidClient({
    apiUrl:
      process.env.WALLID_API_URL || "https://payment-api.wallid.co/api/payment-gw/v1",
    keyId,
    keySecret,
    webhookSecret: process.env.WALLID_WEBHOOK_SECRET || "unused",
  })

  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: sessions } = await query.graph({
    entity: "payment_session",
    fields: [
      "id",
      "status",
      "data",
      "created_at",
      "payment_collection.cart.id",
      "payment_collection.cart.completed_at",
    ],
    filters: { provider_id: "pp_card_wallid", status: "pending" },
  })

  const cutoff = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000
  const candidates = (sessions ?? []).filter((s) => {
    const cart = s.payment_collection?.cart
    if (!cart?.id || cart.completed_at) return false
    const createdAt = new Date(s.created_at as unknown as string).getTime()
    return Number.isFinite(createdAt) && createdAt >= cutoff
  })

  for (const session of candidates) {
    const apiPaymentId = (session.data as { api_payment_id?: string } | undefined)
      ?.api_payment_id
    if (!apiPaymentId) continue

    try {
      const payment = await client.getPayment(apiPaymentId)
      if (payment.status !== "SUCCESS") continue

      await processPaymentWorkflow(container).run({
        input: {
          action: PaymentActions.SUCCESSFUL,
          data: {
            session_id: session.id,
            amount: new BigNumber(Number(payment.amount ?? 0) / 100),
          },
        },
      })
      logger.info(
        `wallid-reconcile: betaalde sessie ${session.id} afgerond (cart ${session.payment_collection?.cart?.id}).`
      )
    } catch (e) {
      logger.warn(
        `wallid-reconcile: sessie ${session.id} niet kunnen verwerken: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
  }
}

export const config = {
  name: "wallid-reconcile",
  schedule: "*/5 * * * *",
}
