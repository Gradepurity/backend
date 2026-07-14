// Bouwt de e-maildata voor een order op uit de query-graph, zodat de subscribers
// (order.placed / payment.captured / shipment.created) dezelfde, betrouwbaar
// berekende totalen en regels gebruiken.
//
// BELANGRIJK: vraag `items.*` op (niet losse velden als items.quantity). Alleen
// met de wildcard triggert het order-module de totaalberekening; losse velden
// geven anders undefined/0 terug (quantity zit op de order_item-detail, prijzen
// zijn BigNumber). Met `items.*` komen quantity/unit_price/total als gewone
// getallen mee, en de order-totalen (total/item_total/...) kloppen.

import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { MedusaContainer } from "@medusajs/framework/types"
import { OrderEmailData, PaymentMethod } from "../modules/resend/templates"

export type OrderEmailPayload = {
  /** Ontvanger van de mail. */
  email: string
  data: OrderEmailData
}

/** Normaliseert getallen die soms als BigNumber-object of string binnenkomen. */
function toNum(v: unknown): number {
  if (v == null) return 0
  if (typeof v === "number") return v
  if (typeof v === "string") {
    const n = parseFloat(v)
    return isNaN(n) ? 0 : n
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>
    return toNum(o.value ?? o.amount ?? o.numeric)
  }
  return 0
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
      "total",
      "item_total",
      "shipping_total",
      "tax_total",
      // Wildcard = totalen worden berekend en quantity/unit_price komen als getal mee.
      "items.*",
      "shipping_address.first_name",
      "shipping_address.last_name",
      "shipping_address.address_1",
      "shipping_address.postal_code",
      "shipping_address.city",
      "shipping_address.country_code",
      "shipping_address.phone",
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
      title: i.product_title ?? i.title,
      subtitle: i.variant_title ?? i.subtitle,
      quantity: Math.round(toNum(i.quantity)) || 1,
      unit_price: toNum(i.unit_price),
    })),
    totals: {
      subtotal: toNum(order.item_total),
      shipping: toNum(order.shipping_total),
      tax: toNum(order.tax_total),
      total: toNum(order.total),
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

  // Wallid hosted checkout (pp_card_wallid): de order ontstaat pas ná een
  // geslaagde betaling — de klant heeft dus al betaald.
  if (providerIds.some((id) => id.includes("wallid") || id.includes("pp_card"))) {
    return "wallid"
  }
  if (providerIds.some((id) => id.includes("btcpay") || id.includes("crypto"))) {
    return "crypto"
  }
  // Bankoverschrijving loopt via de manual/system-provider (pp_system_default).
  if (providerIds.some((id) => id.includes("system") || id.includes("manual"))) {
    return "bank"
  }
  return "other"
}
