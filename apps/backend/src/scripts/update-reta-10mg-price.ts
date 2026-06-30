import { MedusaContainer } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * One-off: set the Retatrutide 10 mg vial base price to €74,95.
 *   npx medusa exec ./src/scripts/update-reta-10mg-price.ts
 */
const CURRENCY = "eur"
const NEW_BASE = 74.95

export default async function updateRetaBase({
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

  const target = (variants as any[]).find(
    (v) => v.product?.title === "Retatrutide" && v.title === "10 mg vial"
  )
  if (!target?.price_set?.id) {
    logger.error("Retatrutide 10 mg vial (with price_set) not found.")
    return
  }

  const base = (target.price_set.prices ?? []).find(
    (p: any) => p.currency_code === CURRENCY && p.min_quantity == null
  )
  if (!base) {
    logger.error("Base EUR price (min_quantity null) not found for 10 mg.")
    return
  }

  await pricing.removePrices([base.id])
  await pricing.addPrices({
    priceSetId: target.price_set.id,
    prices: [
      {
        amount: NEW_BASE,
        currency_code: CURRENCY,
        min_quantity: null,
        max_quantity: null,
      },
    ],
  })

  logger.info(
    `Retatrutide 10 mg base updated: €${Number(base.amount).toFixed(
      2
    )} → €${NEW_BASE.toFixed(2)}. Now run setup-bulk-pricing.ts to refresh tiers.`
  )
}
