import { MedusaContainer } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * Diepe betaal-inspectie voor één order: payment_collections, payments en
 * ALLE payment_sessions (incl. eerdere pogingen via andere providers).
 *
 *   npx medusa exec ./src/scripts/inspect-order-payment.ts <display_id>
 */
export default async function inspectOrderPayment({
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
    logger.error("Gebruik: npx medusa exec ./src/scripts/inspect-order-payment.ts <display_id>")
    return
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "created_at",
      "email",
      "total",
      "currency_code",
      "payment_status",
      "payment_collections.id",
      "payment_collections.amount",
      "payment_collections.status",
      "payment_collections.authorized_amount",
      "payment_collections.captured_amount",
      "payment_collections.payments.id",
      "payment_collections.payments.amount",
      "payment_collections.payments.provider_id",
      "payment_collections.payments.captured_at",
      "payment_collections.payments.created_at",
      "payment_collections.payments.data",
      "payment_collections.payment_sessions.id",
      "payment_collections.payment_sessions.provider_id",
      "payment_collections.payment_sessions.status",
      "payment_collections.payment_sessions.amount",
      "payment_collections.payment_sessions.created_at",
      "payment_collections.payment_sessions.updated_at",
      "payment_collections.payment_sessions.data",
    ],
    filters: { display_id: displayId } as any,
  })

  const order = (orders as any[])[0]
  if (!order) {
    logger.error(`Order #${displayId} niet gevonden`)
    return
  }

  logger.info(`\n===== ORDER #${order.display_id} =====`)
  logger.info(`id=${order.id} | created=${order.created_at} | email=${order.email}`)
  logger.info(`total=€${order.total} ${order.currency_code} | payment_status=${order.payment_status}`)

  for (const pc of order.payment_collections ?? []) {
    logger.info(`\n  payment_collection ${pc.id}`)
    logger.info(`    status=${pc.status} | amount=€${pc.amount} | authorized=€${pc.authorized_amount} | captured=€${pc.captured_amount}`)
    for (const p of pc.payments ?? []) {
      logger.info(`    payment ${p.id} | provider=${p.provider_id} | amount=€${p.amount}`)
      logger.info(`      created=${p.created_at} | captured_at=${p.captured_at ?? "(NIET gecaptured)"}`)
      const pd = p.data ?? {}
      logger.info(`      data-keys: ${Object.keys(pd).join(", ")}`)
    }
    const sessions = [...(pc.payment_sessions ?? [])].sort(
      (a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    )
    for (const s of sessions) {
      logger.info(`    session ${s.id} | provider=${s.provider_id} | medusa-status=${s.status}`)
      logger.info(`      amount=€${Number(s.amount).toFixed(2)} | created=${s.created_at} | updated=${s.updated_at}`)
      const sd = s.data ?? {}
      const interesting = ["api_payment_id", "apiPaymentId", "wallid_order_id", "cloudPosId", "status", "bank_status", "qr_url", "reference"]
        .filter((k) => sd[k] !== undefined)
        .map((k) => `${k}=${sd[k]}`)
      logger.info(`      data-keys: ${Object.keys(sd).join(", ")}${interesting.length ? ` | ${interesting.join(" | ")}` : ""}`)
    }
  }
  logger.info(`\n===== EIND =====\n`)
}
