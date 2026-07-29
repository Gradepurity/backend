import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * READ-ONLY: gevulde winkelmandjes van GISTERAVOND t/m NU die NIET tot een
 * order zijn afgerekend (verlaten checkout). Toont per mandje de items, het
 * land, en de betaalstap/Wallid-status zodat we zien of iemand op de betaling
 * is vastgelopen (EXPIRED/error) of nooit tot betalen is gekomen.
 *
 * Venster = vanaf vandaag 00:00 (Europe/Amsterdam) minus <uren_terug> uur.
 * Standaard 6 uur terug = gisteren 18:00; geef 24 mee voor heel gisteren.
 *   npx medusa exec ./src/scripts/carts-verlaten-venster.ts [uren_terug]
 */
export default async function cartsVerlatenVenster({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const urenTerug = Number(args?.[0] ?? 6)
  const now = new Date()
  const startWindow = new Date(now)
  startWindow.setHours(0, 0, 0, 0) // vandaag 00:00 lokaal
  startWindow.setHours(startWindow.getHours() - urenTerug)

  const tijd = (d: any) =>
    new Date(d).toLocaleString("nl-NL", {
      timeZone: "Europe/Amsterdam",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    })

  const { data: carts } = await query.graph({
    entity: "cart",
    fields: [
      "id",
      "email",
      "created_at",
      "updated_at",
      "completed_at",
      "currency_code",
      "items.product_title",
      "items.title",
      "items.variant_title",
      "items.quantity",
      "items.unit_price",
      "shipping_address.country_code",
      "shipping_address.first_name",
      "shipping_address.last_name",
      "payment_collection.status",
      "payment_collection.payment_sessions.provider_id",
      "payment_collection.payment_sessions.status",
    ],
    pagination: { take: 1000, skip: 0 } as any,
  })

  const inWindow = (d: any) => d && new Date(d) >= startWindow
  const rows = (carts as any[])
    .filter((c) => inWindow(c.updated_at) || inWindow(c.created_at))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))

  const withItems = rows.filter((c) => (c.items ?? []).length > 0)
  const abandoned = withItems.filter((c) => !c.completed_at)
  const completed = withItems.filter((c) => c.completed_at)
  const empty = rows.filter((c) => (c.items ?? []).length === 0)

  logger.info(
    `\n===== MANDJES sinds ${tijd(startWindow)} =====\n` +
      `totaal actief: ${rows.length} | met producten: ${withItems.length} | ` +
      `VERLATEN (geen order): ${abandoned.length} | afgerekend: ${completed.length} | leeg: ${empty.length}`
  )

  logger.info(`\n----- VERLATEN GEVULDE MANDJES (${abandoned.length}) -----`)
  for (const c of abandoned) {
    const naam = [c.shipping_address?.first_name, c.shipping_address?.last_name].filter(Boolean).join(" ")
    const sessions = (c.payment_collection?.payment_sessions ?? [])
      .map((s: any) => `${s.provider_id}:${s.status}`)
      .join(", ")
    const waarde = (c.items ?? []).reduce((s: number, i: any) => s + Number(i.unit_price) * Number(i.quantity), 0)
    logger.info(
      `\n${c.id}\n  ${c.email ?? "(geen email)"}${naam ? ` / ${naam}` : ""} | land=${c.shipping_address?.country_code ?? "-"} | ~€${waarde.toFixed(2)}` +
        `\n  aangemaakt ${tijd(c.created_at)}, laatst actief ${tijd(c.updated_at)}` +
        `\n  betaalstap=${c.payment_collection ? c.payment_collection.status : "NOOIT bereikt"}${sessions ? ` [${sessions}]` : ""}`
    )
    for (const it of c.items ?? []) {
      logger.info(`   ${it.quantity}× ${it.product_title ?? it.title} (${it.variant_title ?? "?"}) — €${it.unit_price}`)
    }
  }

  if (completed.length) {
    logger.info(`\n----- (wel afgerekend in dit venster: ${completed.length}) -----`)
    for (const c of completed) {
      logger.info(`  ${c.email ?? "?"} | laatst actief ${tijd(c.updated_at)} | order=JA`)
    }
  }

  logger.info(`\n===== EIND =====\n`)
}
