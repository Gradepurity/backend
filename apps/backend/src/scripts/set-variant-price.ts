import { MedusaContainer } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Generic: set the base EUR price (min_quantity null) of one product variant.
 * Leaves bulk/staffel tiers untouched.
 *   npx medusa exec ./src/scripts/set-variant-price.ts "Retatrutide" "20 mg vial" 129.95
 */
const CURRENCY = "eur"

export default async function setVariantPrice({
  container,
  args,
}: {
  container: MedusaContainer
  args: string[]
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const pricing = container.resolve(Modules.PRICING)

  const [productTitle, variantTitle, priceStr] = args
  const newPrice = Number(priceStr)
  if (!productTitle || !variantTitle || !Number.isFinite(newPrice)) {
    logger.error(
      'Usage: set-variant-price.ts -- "<product>" "<variant>" <price>'
    )
    return
  }

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
    (v) => v.product?.title === productTitle && v.title === variantTitle
  )
  if (!target?.price_set?.id) {
    logger.error(`"${productTitle}" / "${variantTitle}" (with price_set) not found.`)
    return
  }

  const base = (target.price_set.prices ?? []).find(
    (p: any) => p.currency_code === CURRENCY && p.min_quantity == null
  )
  if (!base) {
    logger.error("Base EUR price (min_quantity null) not found.")
    return
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
    `${productTitle} / ${variantTitle} base updated: €${Number(
      base.amount
    ).toFixed(2)} → €${newPrice.toFixed(2)}. Staffel tiers untouched.`
  )
}
