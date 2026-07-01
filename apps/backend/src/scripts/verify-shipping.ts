import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys, QueryContext } from "@medusajs/framework/utils";

/**
 * Read-only verificatie: wat rekent de checkout écht voor verzending bij een
 * ordertotaal onder en boven €100? Gebruikt dezelfde calculated_price-context
 * als de storefront.
 *   npx medusa exec ./src/scripts/verify-shipping.ts
 */
async function priced(query: any, itemTotal: number) {
  const { data } = await query.graph({
    entity: "shipping_option",
    fields: ["id", "name", "calculated_price.calculated_amount"],
    context: {
      calculated_price: QueryContext({ currency_code: "eur", item_total: itemTotal }),
    },
  });
  return data as any[];
}

export default async function verifyShipping({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  for (const total of [50, 150]) {
    logger.info(`\n===== ordertotaal €${total} =====`);
    const rows = await priced(query, total);
    for (const o of rows) {
      const amt = o.calculated_price?.calculated_amount;
      logger.info(`  ${o.name}: verzendkosten = €${amt != null ? Number(amt).toFixed(2) : "—"}`);
    }
  }
  logger.info("\n===== EIND =====\n");
}
