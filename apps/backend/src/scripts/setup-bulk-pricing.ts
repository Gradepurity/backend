import { MedusaContainer } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Quantity-based bulk discount, applied natively at the Medusa pricing layer so
 * orders are charged the discounted price automatically (no checkout changes).
 *
 * For every variant we ADD three quantity-tier prices alongside the existing
 * base price. Medusa's price selection filters by the cart line quantity and,
 * on a tie, picks the cheapest matching price (ORDER BY amount ASC) — so the
 * right tier is chosen automatically and the base price is never modified:
 *   qty 1–4  → base price
 *   qty 5–9  → −10%
 *   qty 10–14→ −15%
 *   qty 15+  → −20%
 *
 * Idempotent: re-running first removes the tiers it previously added (any EUR
 * price with a min_quantity), then re-adds them from the current base price.
 *
 * Keep these tiers in sync with the storefront (src/lib/pricing.ts).
 *
 * Run:  npx medusa exec ./src/scripts/setup-bulk-pricing.ts
 */
const CURRENCY = "eur"

const TIERS: { minQty: number; maxQty: number | null; fraction: number }[] = [
  { minQty: 5, maxQty: 9, fraction: 0.1 },
  { minQty: 10, maxQty: 14, fraction: 0.15 },
  { minQty: 15, maxQty: null, fraction: 0.2 },
]

export default async function setupBulkPricing({
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
      "price_set.prices.max_quantity",
    ],
  })

  let updated = 0
  let removed = 0
  let skipped = 0

  for (const v of variants as any[]) {
    const priceSet = v.price_set
    const prices: any[] = priceSet?.prices ?? []
    if (!priceSet?.id) {
      skipped++
      continue
    }

    // Base price = the EUR price without a quantity constraint.
    const base = prices.find(
      (p) => p.currency_code === CURRENCY && p.min_quantity == null
    )
    if (!base) {
      skipped++
      continue
    }
    const baseCents = Math.round(Number(base.amount) * 100)

    // Idempotency: drop tiers we added on a previous run.
    const existingTierIds = prices
      .filter((p) => p.currency_code === CURRENCY && p.min_quantity != null)
      .map((p) => p.id)
    if (existingTierIds.length) {
      await pricing.removePrices(existingTierIds)
      removed += existingTierIds.length
    }

    const tierPrices = TIERS.map((t) => ({
      amount: Math.round(baseCents * (1 - t.fraction)) / 100,
      currency_code: CURRENCY,
      min_quantity: t.minQty,
      max_quantity: t.maxQty,
    }))

    await pricing.addPrices({ priceSetId: priceSet.id, prices: tierPrices })
    updated++
    logger.info(
      `· ${v.product?.title ?? "?"} — ${v.title}: base €${(baseCents / 100).toFixed(
        2
      )} → ${tierPrices.map((p) => `€${p.amount.toFixed(2)}@${p.min_quantity}+`).join(", ")}`
    )
  }

  logger.info(
    `Bulk pricing tiers set: ${updated} variants updated, ${removed} old tiers removed, ${skipped} skipped (no EUR base price).`
  )
}
