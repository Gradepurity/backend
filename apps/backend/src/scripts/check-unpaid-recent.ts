import { MedusaContainer } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { BankpayClient, mapBankpayStatus } from "../modules/bankpay/lib/client"

/**
 * READ-ONLY: alle orders van de laatste N uur (default 24) met betaalstatus;
 * voor onbetaalde pp_sepa_bankpay-orders wordt de live status bij bankpay.plus
 * opgevraagd zodat je ziet: verlaten poging vs. betaald-maar-niet-gecaptured.
 *   npx medusa exec ./src/scripts/check-unpaid-recent.ts [uren]
 */
export default async function checkUnpaidRecent({
  container,
  args,
}: {
  container: MedusaContainer
  args?: string[]
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const hours = Number((args ?? [])[0]) || 24

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "display_id",
      "status",
      "created_at",
      "email",
      "total",
      "currency_code",
      "shipping_address.country_code",
      "payment_collections.payments.provider_id",
      "payment_collections.payments.captured_at",
      "payment_collections.payment_sessions.provider_id",
      "payment_collections.payment_sessions.data",
    ],
    pagination: { take: 1000, skip: 0 } as any,
  })

  const cutoff = Date.now() - hours * 3600 * 1000
  const rows = (orders as any[])
    .filter((o) => new Date(o.created_at).getTime() > cutoff)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))

  const tijd = (d: any) =>
    new Date(d).toLocaleString("nl-NL", {
      timeZone: "Europe/Amsterdam",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })

  const privateKey = process.env.BANKPAY_API_KEY
  const clientId = process.env.BANKPAY_CLIENT_ID
  const client =
    privateKey && clientId
      ? new BankpayClient({
          apiUrl: process.env.BANKPAY_API_URL || "https://bankpay.plus",
          privateKey,
          clientId,
        })
      : null

  logger.info(`\n===== ORDERS LAATSTE ${hours} UUR: ${rows.length} =====`)
  let unpaidCount = 0
  for (const o of rows) {
    const payments = (o.payment_collections ?? []).flatMap((pc: any) => pc.payments ?? [])
    const captured = payments.some((p: any) => p.captured_at)
    const provider =
      payments.map((p: any) => String(p.provider_id).replace(/^pp_/, "")).join(",") ||
      (o.payment_collections ?? [])
        .flatMap((pc: any) => pc.payment_sessions ?? [])
        .map((s: any) => String(s.provider_id).replace(/^pp_/, ""))
        .join(",") ||
      "?"

    let live = ""
    if (!captured) {
      unpaidCount++
      const session = (o.payment_collections ?? [])
        .flatMap((pc: any) => pc.payment_sessions ?? [])
        .find((s: any) => s.provider_id === "pp_sepa_bankpay")
      const checkoutUuid = session?.data?.checkout_uuid
      if (checkoutUuid && client) {
        try {
          const status = await client.getStatus(checkoutUuid)
          const mapped = mapBankpayStatus(status)
          live = ` | LIVE BANKpay: ${JSON.stringify(status)} -> ${mapped.toUpperCase()}`
        } catch (e: any) {
          live = ` | LIVE BANKpay: FOUT ${e?.message ?? e}`
        }
      } else if (!checkoutUuid) {
        live = " | geen bankpay-sessie"
      }
    }

    logger.info(
      `#${o.display_id} | ${tijd(o.created_at)} | ${o.email} | ${String(o.shipping_address?.country_code ?? "-").toUpperCase()} | ` +
        `€${Number(o.total).toFixed(2)} | order-status=${o.status} | ${provider} | ${captured ? "BETAALD" : "ONBETAALD"}${live}`
    )
  }
  logger.info(`===== ONBETAALD: ${unpaidCount} van ${rows.length} =====\n`)
}
