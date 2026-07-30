import { MedusaContainer } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * Overzicht van alle orders per betaalprovider sinds een datum, met capture-status.
 * Doel: zien hoeveel klanten BANKpay (pp_sepa_bankpay) daadwerkelijk gebruiken/betalen
 * versus handmatige vooruitbetaling (pp_system_default) en Wallid.
 *   npx medusa exec ./src/scripts/bankpay-stats.ts [dagen-terug, default 14]
 */
export default async function bankpayStats({
  container,
  args,
}: {
  container: MedusaContainer
  args?: string[]
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const days = Number((args ?? [])[0]) || 14
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "display_id",
      "created_at",
      "email",
      "status",
      "summary.current_order_total",
      "shipping_address.country_code",
      "payment_collections.payments.provider_id",
      "payment_collections.payments.captured_at",
      "payment_collections.payment_sessions.provider_id",
    ],
    filters: { created_at: { $gte: since } } as any,
  })

  const rows = (orders as any[])
    .filter((o) => o.status !== "canceled")
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

  const perProvider: Record<string, { n: number; paid: number; sum: number; sumPaid: number }> = {}

  logger.info(`\n===== ORDERS LAATSTE ${days} DAGEN (excl. geannuleerd): ${rows.length} =====`)
  for (const o of rows) {
    const payments = (o.payment_collections ?? []).flatMap((pc: any) => pc.payments ?? [])
    const sessions = (o.payment_collections ?? []).flatMap((pc: any) => pc.payment_sessions ?? [])
    const provider =
      payments[0]?.provider_id ?? sessions[0]?.provider_id ?? "(geen)"
    const captured = payments.some((p: any) => p.captured_at)
    const total = Number(o.summary?.current_order_total ?? 0)

    const key = String(provider).replace(/^pp_/, "")
    perProvider[key] ??= { n: 0, paid: 0, sum: 0, sumPaid: 0 }
    perProvider[key].n++
    perProvider[key].sum += total
    if (captured) {
      perProvider[key].paid++
      perProvider[key].sumPaid += total
    }

    logger.info(
      `#${o.display_id} | ${new Date(o.created_at).toLocaleString("nl-NL")} | ${String(
        o.shipping_address?.country_code ?? "?"
      ).toUpperCase()} | €${total.toFixed(2)} | ${key} | ${captured ? "BETAALD" : "open"}`
    )
  }

  logger.info(`\n===== PER PROVIDER =====`)
  for (const [k, v] of Object.entries(perProvider)) {
    const pct = v.n ? Math.round((v.paid / v.n) * 100) : 0
    logger.info(
      `${k}: ${v.n} orders, ${v.paid} betaald (${pct}%) | omzet €${v.sumPaid.toFixed(2)} betaald van €${v.sum.toFixed(2)}`
    )
  }
  logger.info(`===== EIND =====\n`)
}
