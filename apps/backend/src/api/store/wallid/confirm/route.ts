import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  BigNumber,
  ContainerRegistrationKeys,
  PaymentActions,
} from "@medusajs/framework/utils"
import { processPaymentWorkflow } from "@medusajs/medusa/core-flows"
import { WallidClient } from "../../../../modules/wallid/lib/client"

/**
 * Fallback naast de Wallid-webhook: de retourpagina roept dit aan zodra de
 * klant terugkomt van de hosted betaalpagina. We verifiëren de status
 * server-side bij Wallid en draaien bij SUCCESS hetzelfde workflow-pad als de
 * webhook (autoriseren + capturen + cart afronden). Idempotent: is de order er
 * al, dan gebeurt er niets meer.
 *
 * POST /store/wallid/confirm  { cart_id: string }  ->  { status }
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const cartId = String((req.body as { cart_id?: string })?.cart_id ?? "")
  if (!cartId.startsWith("cart_")) {
    res.status(400).json({ message: "cart_id ontbreekt of is ongeldig." })
    return
  }

  const apiUrl = process.env.WALLID_API_URL || "https://payment-api.wallid.co/api/payment-gw/v1"
  const keyId = process.env.WALLID_KEY_ID
  const keySecret = process.env.WALLID_KEY_SECRET
  if (!keyId || !keySecret) {
    res.status(503).json({ message: "Wallid is niet geconfigureerd." })
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
    ],
    filters: { id: cartId },
  })

  const cart = carts[0]
  if (!cart) {
    res.status(404).json({ message: "Cart niet gevonden." })
    return
  }
  if (cart.completed_at) {
    res.json({ status: "completed" })
    return
  }

  const session = (cart.payment_collection?.payment_sessions ?? []).find((s) =>
    s?.provider_id?.startsWith("pp_card_")
  )
  const apiPaymentId = (session?.data as { api_payment_id?: string } | undefined)
    ?.api_payment_id
  if (!session || !apiPaymentId) {
    res.status(404).json({ message: "Geen Wallid-betaalsessie op deze cart." })
    return
  }

  const client = new WallidClient({
    apiUrl,
    keyId,
    keySecret,
    // Niet nodig voor status-calls, wel verplicht in het options-object.
    webhookSecret: process.env.WALLID_WEBHOOK_SECRET || "unused",
  })

  const payment = await client.getPayment(apiPaymentId)

  if (payment.status === "SUCCESS") {
    await processPaymentWorkflow(req.scope).run({
      input: {
        action: PaymentActions.SUCCESSFUL,
        data: {
          session_id: session.id,
          amount: new BigNumber(Number(payment.amount ?? 0) / 100),
        },
      },
    })
    res.json({ status: "success" })
    return
  }

  res.json({ status: payment.status.toLowerCase() })
}
