import { MedusaContainer } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/** Verifies Medusa selects the right bulk tier per quantity. Read-only. */
export default async function verifyBulkPricing({
  container,
}: {
  container: MedusaContainer
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const pricing = container.resolve(Modules.PRICING)

  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: ["id", "title", "product.title", "price_set.id"],
  })

  const samples = (variants as any[])
    .filter((v) =>
      ["Retatrutide", "GHK-Cu", "Survodutide"].includes(v.product?.title)
    )
    .slice(0, 4)

  for (const v of samples) {
    const psId = v.price_set?.id
    if (!psId) continue
    const out: string[] = []
    for (const qty of [1, 4, 5, 9, 10, 14, 15, 20]) {
      const [calc] = await pricing.calculatePrices(
        { id: [psId] },
        { context: { currency_code: "eur", quantity: qty } }
      )
      out.push(`${qty}:€${Number(calc?.calculated_amount).toFixed(2)}`)
    }
    logger.info(`${v.product?.title} — ${v.title}  ${out.join("  ")}`)
  }
}
