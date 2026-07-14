import { MedusaContainer } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Bulk base-price update to undercut Primal Peptides (~€5 onder hun prijs per
 * gedeelde variant, kleinere mg's proportioneel meegeschaald). Spiegelt exact
 * de nieuwe variantprijzen in de storefront (forma/src/lib/data.ts).
 *
 * Zet alleen de EUR-basisprijs (min_quantity null) per variant. De staffel-tiers
 * worden hierna losgetrokken door setup-bulk-pricing.ts opnieuw te draaien:
 *   npx medusa exec ./src/scripts/update-competitor-prices.ts
 *   npx medusa exec ./src/scripts/setup-bulk-pricing.ts
 *
 * Idempotent: opnieuw draaien zet dezelfde bedragen.
 */
const CURRENCY = "eur"

// [productTitle, variantTitle, newPriceEUR]
const UPDATES: [string, string, number][] = [
  ["BPC-157", "2 mg vial", 6.95],
  ["BPC-157", "5 mg vial", 17.95],
  ["BPC-157", "10 mg vial", 34.95],
  ["TB-500", "2 mg vial", 8.95],
  ["TB-500", "5 mg vial", 39.95],
  ["TB-500", "10 mg vial", 44.95],
  ["CJC-1295 (no DAC)", "2 mg vial", 19.95],
  ["CJC-1295 (no DAC)", "5 mg vial", 39.95],
  ["CJC-1295 (no DAC)", "10 mg vial", 44.95],
  ["Selank", "5 mg vial", 19.95],
  ["Selank", "10 mg vial", 24.95],
  ["Semax", "5 mg vial", 19.95],
  ["Semax", "10 mg vial", 24.95],
  ["Cagrilintide", "5 mg vial", 49.95],
  ["Cagrilintide", "10 mg vial", 64.95],
  ["PT-141", "10 mg vial", 34.95],
  ["GHRP-6", "5 mg vial", 17.95],
  ["GHRP-6", "10 mg vial", 34.95],
  ["SNAP-8", "10 mg vial", 24.95],
  ["SS-31", "10 mg vial", 39.95],
  ["SS-31", "50 mg vial", 194.95],
]

export default async function updateCompetitorPrices({
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
      "price_set.id",
      "price_set.prices.id",
      "price_set.prices.amount",
      "price_set.prices.currency_code",
      "price_set.prices.min_quantity",
    ],
  })

  let done = 0
  const missing: string[] = []

  for (const [productTitle, variantTitle, newPrice] of UPDATES) {
    const target = (variants as any[]).find(
      (v) => v.product?.title === productTitle && v.title === variantTitle
    )
    if (!target?.price_set?.id) {
      missing.push(`${productTitle} / ${variantTitle}`)
      continue
    }

    const base = (target.price_set.prices ?? []).find(
      (p: any) => p.currency_code === CURRENCY && p.min_quantity == null
    )
    if (!base) {
      missing.push(`${productTitle} / ${variantTitle} (geen EUR-basisprijs)`)
      continue
    }

    if (Number(base.amount) === newPrice) {
      logger.info(`= ${productTitle} / ${variantTitle}: al €${newPrice.toFixed(2)}`)
      done++
      continue
    }

    await pricing.removePrices([base.id])
    await pricing.addPrices({
      priceSetId: target.price_set.id,
      prices: [
        {
          amount: newPrice,
          currency_code: CURRENCY,
          min_quantity: null,
          max_quantity: null,
        },
      ],
    })
    logger.info(
      `· ${productTitle} / ${variantTitle}: €${Number(base.amount).toFixed(
        2
      )} → €${newPrice.toFixed(2)}`
    )
    done++
  }

  logger.info(
    `Klaar: ${done}/${UPDATES.length} bijgewerkt.` +
      (missing.length ? ` NIET gevonden: ${missing.join("; ")}` : "")
  )
  if (missing.length) {
    logger.warn(
      "Controleer de niet-gevonden product/variant-titels tegen Medusa vóór je verder gaat."
    )
  }
}
