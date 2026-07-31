import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * READ-ONLY dry-run van de cancel-stale-unpaid-job: toont welke orders bij de
 * eerstvolgende run geannuleerd zouden worden (onbetaald, ouder dan de termijn,
 * niet verzonden). Annuleert en mailt NIETS.
 *   npx medusa exec ./src/scripts/cancel-stale-unpaid-dryrun.ts [dagen]
 */
export default async function cancelStaleUnpaidDryrun({ container, args }: ExecArgs) {
  const logger = container.resolve("logger")
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const graceDays = Number(args?.[0] ?? process.env.CANCEL_STALE_UNPAID_DAYS ?? 7)
  const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000)

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "email",
      "status",
      "created_at",
      "payment_collections.payments.captured_at",
      "fulfillments.shipped_at",
      "fulfillments.canceled_at",
    ],
    filters: { status: "pending" } as any,
  })

  const stale = (orders as any[])
    .filter((o) => o.status === "pending")
    .filter((o) => new Date(o.created_at) < cutoff)
    .filter(
      (o) =>
        !(o.payment_collections ?? [])
          .flatMap((pc: any) => pc.payments ?? [])
          .some((p: any) => p.captured_at)
    )
    .filter((o) => !(o.fulfillments ?? []).some((f: any) => !f.canceled_at && f.shipped_at))
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

  logger.info(`\n===== DRY-RUN cancel-stale-unpaid (termijn ${graceDays} dagen) =====`)
  if (!stale.length) {
    logger.info("Geen orders die geannuleerd zouden worden.")
    return
  }
  for (const o of stale) {
    logger.info(
      `  #${o.display_id} | ${new Date(o.created_at).toLocaleString("nl-NL")} | ${o.email}`
    )
  }
  logger.info(`Totaal: ${stale.length} order(s) zouden worden geannuleerd + gemaild.`)
}
