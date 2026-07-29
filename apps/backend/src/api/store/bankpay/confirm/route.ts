import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  ContainerRegistrationKeys,
  PaymentActions,
} from "@medusajs/framework/utils"
import { processPaymentWorkflow } from "@medusajs/medusa/core-flows"
import { BankpayClient, mapBankpayStatus } from "../../../../modules/bankpay/lib/client"
import { fetchOrderSummary } from "../../../../lib/order-summary"

/**
 * Statuspad voor de storefront-wachtpagina (en fallback naast de IPN).
 *
 * Vorkasse-model (29-07): de cart wordt bij het afrekenen al afgerond, dus
 * "cart completed" zegt niets over betaald. Betaald = de CAPTURE op de
 * payment. Voor een afgeronde cart checken we daarom de capture; zolang die
 * er niet is halen we de status live bij BANKpay+ op en capturen we zelf
 * zodra die betaald meldt — hetzelfde (idempotente) workflow-pad als de
 * 5-minuten-reconcile, maar dan seconden na de betaling omdat de wachtpagina
 * elke paar seconden pollt.
 *
 * POST /store/bankpay/confirm  { cart_id: string }
 *   -> { status: "paid", order }        betaling binnen (capture gezet)
 *   -> { status: "pending_payment" }    order bestaat, betaling nog niet
 *   -> { status: "completed", order }   afgeronde cart zonder BANKpay-sessie
 *   -> { status: <mapped> }             pre-Vorkasse pad (cart nog open)
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const cartId = String((req.body as { cart_id?: string })?.cart_id ?? "")
  if (!cartId.startsWith("cart_")) {
    res.status(400).json({ message: "cart_id ontbreekt of is ongeldig." })
    return
  }

  const privateKey = process.env.BANKPAY_API_KEY
  const clientId = process.env.BANKPAY_CLIENT_ID
  if (!privateKey || !clientId) {
    res.status(503).json({ message: "BANKpay+ is niet geconfigureerd." })
    return
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: carts } = await query.graph({
    entity: "cart",
    fields: [
      "id",
      "completed_at",
      "payment_collection.payment_sessions.id",
      "payment_collection.payment_sessions.provider_id",
      "payment_collection.payment_sessions.data",
      "payment_collection.payment_sessions.amount",
      "payment_collection.payments.id",
      "payment_collection.payments.captured_at",
      "payment_collection.payments.canceled_at",
    ],
    filters: { id: cartId },
  })

  const cart = carts[0]
  if (!cart) {
    res.status(404).json({ message: "Cart niet gevonden." })
    return
  }

  const session = (cart.payment_collection?.payment_sessions ?? []).find((s) =>
    s?.provider_id?.startsWith("pp_sepa_")
  )
  const checkoutUuid = (session?.data as { checkout_uuid?: string } | undefined)
    ?.checkout_uuid

  const client = new BankpayClient({
    apiUrl: process.env.BANKPAY_API_URL || "https://bankpay.plus",
    privateKey,
    clientId,
  })

  if (cart.completed_at) {
    const payments = cart.payment_collection?.payments ?? []
    if (payments.some((p) => p?.captured_at)) {
      res.json({ status: "paid", order: await fetchOrderSummary(req, cartId) })
      return
    }
    if (!session || !checkoutUuid) {
      // Afgeronde cart zonder BANKpay-sessie (andere provider/legacy): het
      // oude antwoord, de wachtpagina hoort hier nooit te komen.
      res.json({ status: "completed", order: await fetchOrderSummary(req, cartId) })
      return
    }
    const status = await client.getStatus(checkoutUuid)
    if (mapBankpayStatus(status) === "paid") {
      await processPaymentWorkflow(req.scope).run({
        input: {
          action: PaymentActions.SUCCESSFUL,
          data: {
            session_id: session.id,
            amount: session.amount,
          },
        },
      })
      res.json({ status: "paid", order: await fetchOrderSummary(req, cartId) })
      return
    }
    res.json({ status: "pending_payment" })
    return
  }

  if (!session || !checkoutUuid) {
    res.status(404).json({ message: "Geen BANKpay+-betaalsessie op deze cart." })
    return
  }

  const status = await client.getStatus(checkoutUuid)
  const mapped = mapBankpayStatus(status)

  if (mapped === "paid") {
    await processPaymentWorkflow(req.scope).run({
      input: {
        action: PaymentActions.SUCCESSFUL,
        data: {
          session_id: session.id,
          amount: session.amount,
        },
      },
    })
    res.json({ status: "success", order: await fetchOrderSummary(req, cartId) })
    return
  }

  res.json({ status: mapped })
}
