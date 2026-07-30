import { MedusaContainer } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { BankpayClient, mapBankpayStatus } from "../modules/bankpay/lib/client"

/**
 * Live BANKpay+-status voor één order: haalt de checkout_uuid van de
 * pp_sepa_bankpay-sessie op en vraagt de echte status bij bankpay.plus op.
 * "paid" = geld onderweg/binnen -> de 5-min-reconcile captured vanzelf
 * (of draai capture-bank-payment.ts). Alles anders = klant heeft (nog) niet
 * betaald.
 *   npx medusa exec ./src/scripts/bankpay-status.ts <display_id>
 */
export default async function bankpayStatus({
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
    logger.error("Gebruik: npx medusa exec ./src/scripts/bankpay-status.ts <display_id>")
    return
  }

  const privateKey = process.env.BANKPAY_API_KEY
  const clientId = process.env.BANKPAY_CLIENT_ID
  if (!privateKey || !clientId) {
    logger.error("BANKPAY_API_KEY/BANKPAY_CLIENT_ID ontbreken in de env.")
    return
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "display_id",
      "email",
      "payment_collections.payments.captured_at",
      "payment_collections.payment_sessions.provider_id",
      "payment_collections.payment_sessions.data",
    ],
    filters: { display_id: displayId } as any,
  })
  const order = (orders as any[])[0]
  if (!order) {
    logger.error(`Order #${displayId} niet gevonden.`)
    return
  }

  const captured = (order.payment_collections ?? [])
    .flatMap((pc: any) => pc.payments ?? [])
    .some((p: any) => p.captured_at)

  const session = (order.payment_collections ?? [])
    .flatMap((pc: any) => pc.payment_sessions ?? [])
    .find((s: any) => s.provider_id === "pp_sepa_bankpay")
  const checkoutUuid = session?.data?.checkout_uuid
  if (!checkoutUuid) {
    logger.error(`Order #${displayId} heeft geen BANKpay-sessie (checkout_uuid).`)
    return
  }

  const client = new BankpayClient({
    apiUrl: process.env.BANKPAY_API_URL || "https://bankpay.plus",
    privateKey,
    clientId,
  })
  const status = await client.getStatus(checkoutUuid)
  const mapped = mapBankpayStatus(status)

  logger.info(`\n===== BANKPAY-STATUS #${order.display_id} (${order.email}) =====`)
  logger.info(`checkout_uuid:   ${checkoutUuid}`)
  logger.info(`BANKpay ruw:     ${JSON.stringify(status)}`)
  logger.info(`Vertaald:        ${mapped.toUpperCase()}${mapped === "paid" ? " ✅ (reconcile captured binnen 5 min)" : ""}`)
  logger.info(`Medusa captured: ${captured ? "JA — al als betaald verwerkt" : "nee"}`)
  logger.info(`===== EIND =====\n`)
}
