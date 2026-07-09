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
 * Bij een afgeronde betaling sturen we de order-samenvatting mee zodat de
 * retourpagina een volledige bevestiging kan tonen (ordernummer, regels,
 * bedragen, adres). De cart-id is een onraadbare bearer-referentie die alleen
 * de browser van de koper kent.
 *
 * POST /store/wallid/confirm  { cart_id: string }  ->  { status, order? }
 */
type OrderSummary = {
  displayId: number
  currency: string
  subtotal: number
  shippingTotal: number
  taxTotal: number
  total: number
  items: { title: string; quantity: number; total: number }[]
  customer: {
    firstName: string
    lastName: string
    address: string
    postalCode: string
    city: string
    email: string
    phone?: string
  }
}

async function fetchOrderSummary(
  req: MedusaRequest,
  cartId: string
): Promise<OrderSummary | null> {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const { data: links } = await query.graph({
    entity: "order_cart",
    fields: ["order_id"],
    filters: { cart_id: cartId },
  })
  const orderId = links[0]?.order_id
  if (!orderId) {
    return null
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "email",
      "currency_code",
      "total",
      "subtotal",
      "shipping_total",
      "tax_total",
      "items.title",
      "items.product_title",
      "items.variant_title",
      "items.quantity",
      "items.total",
      "shipping_address.first_name",
      "shipping_address.last_name",
      "shipping_address.address_1",
      "shipping_address.postal_code",
      "shipping_address.city",
      "shipping_address.phone",
    ],
    filters: { id: orderId },
  })
  const order = orders[0]
  if (!order) {
    return null
  }

  const addr = order.shipping_address
  return {
    displayId: Number(order.display_id ?? 0),
    currency: order.currency_code,
    subtotal: Number(order.subtotal ?? 0),
    shippingTotal: Number(order.shipping_total ?? 0),
    taxTotal: Number(order.tax_total ?? 0),
    total: Number(order.total ?? 0),
    items: (order.items ?? []).filter(Boolean).map((i) => ({
      title:
        [i!.product_title, i!.variant_title].filter(Boolean).join(" · ") ||
        i!.title ||
        "Item",
      quantity: Number(i!.quantity ?? 1),
      total: Number(i!.total ?? 0),
    })),
    customer: {
      firstName: addr?.first_name ?? "",
      lastName: addr?.last_name ?? "",
      address: addr?.address_1 ?? "",
      postalCode: addr?.postal_code ?? "",
      city: addr?.city ?? "",
      email: order.email ?? "",
      phone: addr?.phone ?? undefined,
    },
  }
}

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
    res.json({ status: "completed", order: await fetchOrderSummary(req, cartId) })
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
    res.json({ status: "success", order: await fetchOrderSummary(req, cartId) })
    return
  }

  res.json({ status: payment.status.toLowerCase() })
}
