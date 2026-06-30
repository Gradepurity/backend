import { MedusaContainer } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Surgical removal of quantity-tier prices from ACCESSORY variants only
 * (metadata.accessory === true) — losse benodigdheden (naalden/water/swabs)
 * krijgen geen staffelkorting. Laat alle peptide-tiers ongemoeid.
 *
 * Read-then-remove, idempotent, only touches accessories. Run with:
 *   npx medusa exec ./src/scripts/clear-accessory-bulk-pricing.ts
 */
const CURRENCY = "eur"

export default async function clearAccessoryBulkPricing({
  container,
}: {
  container: MedusaContainer
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const pricing = container.resolve(Modules.PRICING)

  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: [
      "id",
      "title",
      "product.title",
      "product.metadata",
      "price_set.prices.id",
      "price_set.prices.currency_code",
      "price_set.prices.min_quantity",
    ],
  })

  let cleared = 0
  let removed = 0

  for (const v of variants as any[]) {
    if (v.product?.metadata?.accessory !== true) continue

    const tierIds = (v.price_set?.prices ?? [])
      .filter(
        (p: any) => p.currency_code === CURRENCY && p.min_quantity != null
      )
      .map((p: any) => p.id)

    if (tierIds.length) {
      await pricing.removePrices(tierIds)
      removed += tierIds.length
      cleared++
      logger.info(
        `· ${v.product?.title ?? "?"} — ${v.title}: ${tierIds.length} staffeltier(s) verwijderd.`
      )
    } else {
      logger.info(`· ${v.product?.title ?? "?"} — ${v.title}: geen tiers, niets te doen.`)
    }
  }

  logger.info(
    `Accessoire-staffel opgeruimd: ${cleared} variant(en), ${removed} tier-prijs(en) verwijderd.`
  )
}
