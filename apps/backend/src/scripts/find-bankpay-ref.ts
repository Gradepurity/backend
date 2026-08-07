import { MedusaContainer } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * READ-ONLY: zoek de order bij een BANKpay-betaalreferentie.
 * De referentie op het bankafschrift is "GradePurity <laatste 10 tekens van de
 * payment-session-id>" (zie modules/bankpay/service.ts).
 *   npx medusa exec ./src/scripts/find-bankpay-ref.ts <REF>
 */
export default async function findBankpayRef({
  container,
  args,
}: {
  container: MedusaContainer
  args?: string[]
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const ref = (args ?? [])[0]
  if (!ref) {
    logger.error("Gebruik: npx medusa exec ./src/scripts/find-bankpay-ref.ts <REF>")
    return
  }

  const { data: sessions } = await query.graph({
    entity: "payment_session",
    fields: [
      "id",
      "provider_id",
      "amount",
      "status",
      "created_at",
      "payment_collection.id",
    ],
    pagination: { take: 2000, skip: 0 } as any,
  })

  const hits = (sessions as any[]).filter((s) =>
    String(s.id).toUpperCase().endsWith(ref.toUpperCase())
  )

  if (!hits.length) {
    logger.error(`Geen payment session gevonden die eindigt op "${ref}".`)
    return
  }

  for (const s of hits) {
    const { data: orders } = await query.graph({
      entity: "order",
      fields: [
        "display_id",
        "email",
        "total",
        "currency_code",
        "created_at",
        "status",
        "fulfillment_status",
        "payment_collections.id",
        "payment_collections.status",
        "payment_collections.payments.id",
        "payment_collections.payments.amount",
        "payment_collections.payments.captured_at",
      ],
      pagination: { take: 1000, skip: 0 } as any,
    })
    const order = (orders as any[]).find((o) =>
      (o.payment_collections ?? []).some((pc: any) => pc.id === s.payment_collection?.id)
    )

    logger.info(`\n===== BANKPAY-REF ${ref} =====`)
    logger.info(`Session: ${s.id} | ${s.provider_id} | status=${s.status} | €${s.amount}`)
    if (!order) {
      logger.info(`Geen order aan deze payment collection gekoppeld (afgebroken checkout?).`)
      continue
    }
    const payment = (order.payment_collections ?? []).flatMap((pc: any) => pc.payments ?? [])[0]
    logger.info(
      `Order #${order.display_id} | ${order.email} | €${order.total} ${order.currency_code} | ` +
        `aangemaakt ${new Date(order.created_at).toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" })}`
    )
    logger.info(
      `Payment: ${payment ? `${payment.id} | €${payment.amount} | captured=${payment.captured_at ?? "NEE"}` : "geen"}`
    )
    logger.info(`===== EIND =====\n`)
  }
}
