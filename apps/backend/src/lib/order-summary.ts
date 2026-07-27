import { MedusaRequest } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * Order-samenvatting voor de confirm-fallback-routes van de hosted
 * betaalpagina's (/store/wallid/confirm, /store/bankpay/confirm): de
 * retourpagina toont hiermee een volledige bevestiging (ordernummer, regels,
 * bedragen, adres). Zelfde shape als de Wallid-route altijd teruggaf.
 */
export type OrderSummary = {
  /** Medusa order-id — de storefront koppelt hiermee de gast-order aan een account. */
  orderId: string
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

export async function fetchOrderSummary(
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
      "item_total",
      "shipping_total",
      "tax_total",
      // Wildcard is verplicht: alleen dan rekent de order-module de totalen
      // door en komen quantity/total als getallen mee (zie lib/order-email.ts).
      "items.*",
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

  // Bedragen komen soms als BigNumber-object of string binnen.
  const toNum = (v: unknown): number => {
    if (v == null) return 0
    if (typeof v === "number") return v
    if (typeof v === "string") {
      const n = parseFloat(v)
      return Number.isNaN(n) ? 0 : n
    }
    if (typeof v === "object") {
      const o = v as Record<string, unknown>
      return toNum(o.value ?? o.amount ?? o.numeric)
    }
    return 0
  }

  const addr = order.shipping_address
  return {
    orderId: order.id,
    displayId: Number(order.display_id ?? 0),
    currency: order.currency_code,
    subtotal: toNum(order.item_total),
    shippingTotal: toNum(order.shipping_total),
    taxTotal: toNum(order.tax_total),
    total: toNum(order.total),
    items: (order.items ?? []).filter(Boolean).map((i: any) => ({
      title:
        [i.product_title, i.variant_title].filter(Boolean).join(" · ") ||
        i.title ||
        "Item",
      quantity: Math.round(toNum(i.quantity)) || 1,
      total: toNum(i.total),
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
