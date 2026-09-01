import { MedusaContainer } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * Read-only: betaalde-maar-niet-verzonden orders met inhoud (line items) + verzendadres.
 *   npx medusa exec ./src/scripts/open-orders-inhoud.ts
 */
export default async function openOrdersInhoud({ container }: { container: MedusaContainer }) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "display_id", "created_at", "email", "status", "total", "currency_code",
      "payment_collections.status",
      "fulfillments.id", "fulfillments.shipped_at", "fulfillments.canceled_at",
      "items.*",
      "shipping_address.first_name", "shipping_address.last_name", "shipping_address.company",
      "shipping_address.address_1", "shipping_address.address_2", "shipping_address.postal_code",
      "shipping_address.city", "shipping_address.country_code", "shipping_address.phone",
    ],
  })

  const num = (x: any): number =>
    x && typeof x === "object" ? Number(x.numeric_ ?? x.raw_?.value ?? 0) : Number(x ?? 0)

  const paid = (s: string) => ["completed", "authorized", "captured", "partially_captured"].includes(s)

  const open = (orders ?? []).filter((o: any) => {
    if (o.status === "canceled") return false
    const payStatuses = (o.payment_collections ?? []).map((p: any) => p?.status)
    const isPaid = payStatuses.some(paid)
    const fulfills = o.fulfillments ?? []
    const shipped = fulfills.some((f: any) => f?.shipped_at && !f?.canceled_at)
    return isPaid && !shipped
  }).sort((a: any, b: any) => (b.display_id ?? 0) - (a.display_id ?? 0))

  console.log(`\n===== OPEN (betaald, niet verzonden): ${open.length} orders =====\n`)
  for (const o of open) {
    const a: any = o.shipping_address ?? {}
    const naam = `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim()
    const pay = (o.payment_collections ?? []).map((p: any) => p?.status).join(",")
    console.log(`#${o.display_id} | ${o.created_at} | betaling=${pay} | €${num(o.total).toFixed(2)}`)
    console.log(`  Naar: ${naam}${a.company ? " ("+a.company+")" : ""}`)
    console.log(`        ${a.address_1 ?? ""}${a.address_2 ? " "+a.address_2 : ""}`)
    console.log(`        ${a.postal_code ?? ""} ${a.city ?? ""} (${(a.country_code ?? "?").toUpperCase()})`)
    console.log(`        tel: ${a.phone ?? "-"} | mail: ${o.email}`)
    console.log(`  Besteld:`)
    for (const it of ((o.items ?? []) as any[])) {
      const t = it.product_title || it.title || "?"
      const v = it.variant_title ? ` — ${it.variant_title}` : ""
      console.log(`        ${num(it.quantity)}x ${t}${v}`)
    }
    console.log("")
  }
  console.log("===== EIND =====\n")
}
