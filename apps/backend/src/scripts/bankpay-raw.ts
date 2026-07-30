import { MedusaContainer } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { BankpayClient } from "../modules/bankpay/lib/client"

/**
 * Debug: dump het RUWE antwoord van GET /api/checkout/<uuid> voor één order
 * (alles wat mapBankpayStatus normaal weggooit — o.a. eventuele bankkeuze).
 *   npx medusa exec ./src/scripts/bankpay-raw.ts <display_id>
 */
export default async function bankpayRaw({
  container,
  args,
}: {
  container: MedusaContainer
  args?: string[]
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const displayId = Number((args ?? [])[0])
  if (!displayId) {
    logger.error("Gebruik: npx medusa exec ./src/scripts/bankpay-raw.ts <display_id>")
    return
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["display_id", "payment_collections.payment_sessions.provider_id", "payment_collections.payment_sessions.data"],
    filters: { display_id: displayId } as any,
  })
  const order = (orders as any[])[0]
  const session = (order?.payment_collections ?? [])
    .flatMap((pc: any) => pc.payment_sessions ?? [])
    .find((s: any) => s.provider_id === "pp_sepa_bankpay")
  const uuid = session?.data?.checkout_uuid
  if (!uuid) {
    logger.error(`Geen BANKpay-sessie op #${displayId}.`)
    return
  }

  const client = new BankpayClient({
    apiUrl: process.env.BANKPAY_API_URL || "https://bankpay.plus",
    privateKey: process.env.BANKPAY_API_KEY!,
    clientId: process.env.BANKPAY_CLIENT_ID!,
  })
  const raw = await (client as any).request(`/api/checkout/${encodeURIComponent(String(uuid))}`, {
    method: "GET",
  })
  logger.info(`\n===== RAW BANKPAY /api/checkout/${uuid} =====`)
  logger.info(JSON.stringify(raw, null, 2))
  logger.info(`===== EIND =====\n`)
}
