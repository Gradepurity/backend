// Bouwt de e-maildata voor een order op uit de query-graph, zodat de subscribers
// (order.placed / payment.captured / shipment.created) dezelfde, betrouwbaar
// berekende totalen en regels gebruiken.

import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { MedusaContainer } from "@medusajs/framework/types"
import { OrderEmailData, PaymentMethod } from "../modules/resend/templates"

export type OrderEmailPayload = {
  /** Ontvanger van de mail. */
  email: string
  data: OrderEmailData
}

/**
 * Haalt één order op en mapt het naar het e-mail-datamodel.
 * Retourneert null als de order geen e-mailadres heeft (dan niets versturen).
 */
export async function buildOrderEmailData(
  container: MedusaContainer,
  orderId: string
): Promise<OrderEmailPayload | null> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "email",
      "currency_code",
      "item_total",
      "shipping_total",
      "tax_total",
      "total",
      "items.title",
      "items.subtitle",
      "items.quantity",
      "items.unit_price",
      "shipping_address.first_name",
      "shipping_address.last_name",
      "shipping_address.address_1",
      "shipping_address.postal_code",
      "shipping_address.city",
      "shipping_address.country_code",
      "payment_collections.payments.provider_id",
    ],
    filters: { id: orderId },
  })

  const order = orders?.[0]
  if (!order?.email) return null

  const data: OrderEmailData = {
    display_id: order.display_id ?? order.id,
    currency_code: order.currency_code ?? "eur",
    items: (order.items ?? []).map((i: any) => ({
      title: i.title,
      subtitle: i.subtitle,
      quantity: i.quantity,
      unit_price: Number(i.unit_price ?? 0),
    })),
    totals: {
      subtotal: Number(order.item_total ?? 0),
      shipping: Number(order.shipping_total ?? 0),
      tax: Number(order.tax_total ?? 0),
      total: Number(order.total ?? 0),
    },
    shipping_address: order.shipping_address ?? null,
    payment_method: derivePaymentMethod(order),
  }

  return { email: order.email, data }
}

/** Leidt de betaalmethode af uit de provider-id van de payment(s). */
function derivePaymentMethod(order: any): PaymentMethod {
  const providerIds: string[] = (order.payment_collections ?? [])
    .flatMap((pc: any) => pc.payments ?? [])
    .map((p: any) => String(p.provider_id ?? ""))

  if (providerIds.some((id) => id.includes("btcpay") || id.includes("crypto"))) {
    return "crypto"
  }
  // Bankoverschrijving loopt via de manual/system-provider (geen PSP).
  if (providerIds.some((id) => id.includes("system") || id.includes("manual"))) {
    return "bank"
  }
  return "other"
}
