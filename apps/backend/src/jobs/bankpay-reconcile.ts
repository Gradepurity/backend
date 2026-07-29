import { MedusaContainer } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  PaymentActions,
} from "@medusajs/framework/utils"
import { processPaymentWorkflow } from "@medusajs/medusa/core-flows"
import { BankpayClient, mapBankpayStatus } from "../modules/bankpay/lib/client"

/**
 * Vangnet voor BANKpay+-betalingen. Sinds het Vorkasse-model (29-07) bestaat
 * de order al bij het afrekenen; deze job CAPTURED de betaling zodra BANKpay+
 * de checkout op betaald zet (hun IPN vuurt in de praktijk niet — dit is dus
 * het primaire pad, elke 5 min). processPaymentWorkflow met SUCCESSFUL
 * captured een bestaande payment en is idempotent.
 *
 * Sessies van vóór de omschakeling (cart nooit afgerond) worden via hetzelfde
 * pad alsnog afgerond zodra ze betaald blijken.
 */
const LOOKBACK_HOURS = 48

export default async function bankpayReconcileJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  const privateKey = process.env.BANKPAY_API_KEY
  const clientId = process.env.BANKPAY_CLIENT_ID
  if (!privateKey || !clientId) {
    return // BANKpay+ niet geconfigureerd — niets te doen.
  }

  const client = new BankpayClient({
    apiUrl: process.env.BANKPAY_API_URL || "https://bankpay.plus",
    privateKey,
    clientId,
  })

  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: sessions } = await query.graph({
    entity: "payment_session",
    fields: [
      "id",
      "status",
      "data",
      "amount",
      "created_at",
      "payment_collection.cart.id",
      "payment_collection.cart.completed_at",
      "payment_collection.payments.id",
      "payment_collection.payments.captured_at",
      "payment_collection.payments.canceled_at",
    ],
    filters: {
      provider_id: "pp_sepa_bankpay",
      status: ["pending", "authorized"],
    },
  })

  const cutoff = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000
  const candidates = (sessions ?? []).filter((s) => {
    const cart = s.payment_collection?.cart
    if (!cart?.id) return false
    const createdAt = new Date(s.created_at as unknown as string).getTime()
    if (!Number.isFinite(createdAt) || createdAt < cutoff) return false
    const payments = s.payment_collection?.payments ?? []
    // Al gecaptured of geannuleerd -> niets meer te doen.
    if (payments.some((p) => p?.captured_at || p?.canceled_at)) return false
    return true
  })

  for (const session of candidates) {
    const checkoutUuid = (session.data as { checkout_uuid?: string } | undefined)
      ?.checkout_uuid
    if (!checkoutUuid) continue

    try {
      const status = await client.getStatus(checkoutUuid)
      if (mapBankpayStatus(status) !== "paid") continue

      await processPaymentWorkflow(container).run({
        input: {
          action: PaymentActions.SUCCESSFUL,
          data: {
            session_id: session.id,
            amount: session.amount,
          },
        },
      })
      logger.info(
        `bankpay-reconcile: betaalde sessie ${session.id} verwerkt (cart ${session.payment_collection?.cart?.id}, status ${status.payment} — capture/afronding).`
      )
    } catch (e) {
      logger.warn(
        `bankpay-reconcile: sessie ${session.id} niet kunnen verwerken: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
  }
}

export const config = {
  name: "bankpay-reconcile",
  schedule: "*/5 * * * *",
}
