import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  ContainerRegistrationKeys,
  PaymentActions,
} from "@medusajs/framework/utils"
import { processPaymentWorkflow } from "@medusajs/medusa/core-flows"
import { BankpayClient, mapBankpayStatus } from "../../../../modules/bankpay/lib/client"
import { fetchOrderSummary } from "../../../../lib/order-summary"

/**
 * Fallback naast de BANKpay+-IPN: de retourpagina roept dit aan zodra de klant
 * terugkomt van de hosted betaalpagina. We verifiëren de status server-side
 * bij BANKpay+ en draaien bij "betaald" hetzelfde workflow-pad als de IPN
 * (autoriseren + capturen + cart afronden). Idempotent — zelfde patroon als
 * /store/wallid/confirm.
 *
 * POST /store/bankpay/confirm  { cart_id: string }  ->  { status, order? }
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
    ],
    filters: { id: cartId },
  })

  const cart = carts[0]
  if (!cart) {
    res.status(404).json({ message: "Cart niet gevonden." })
    return
  }
  if (cart.completed_at) {
    res.json({ status: "completed", order: await fetchOrderSummary(req, cartId) })
    return
  }

  const session = (cart.payment_collection?.payment_sessions ?? []).find((s) =>
    s?.provider_id?.startsWith("pp_sepa_")
  )
  const checkoutUuid = (session?.data as { checkout_uuid?: string } | undefined)
    ?.checkout_uuid
  if (!session || !checkoutUuid) {
    res.status(404).json({ message: "Geen BANKpay+-betaalsessie op deze cart." })
    return
  }

  const client = new BankpayClient({
    apiUrl: process.env.BANKPAY_API_URL || "https://bankpay.plus",
    privateKey,
    clientId,
  })

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
