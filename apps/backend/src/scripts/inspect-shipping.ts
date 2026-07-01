import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";

/**
 * Read-only: dump de huidige shipping-opties, hun prijzen en price-rules zodat we
 * weten wat de checkout echt rekent voordat we tarieven gelijktrekken.
 *   npx medusa exec ./src/scripts/inspect-shipping.ts
 */
export default async function inspectShipping({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const { data: options } = await query.graph({
    entity: "shipping_option",
    fields: [
      "id",
      "name",
      "price_type",
      "service_zone.name",
      "service_zone.geo_zones.country_code",
      "prices.id",
      "prices.amount",
      "prices.currency_code",
    ],
  });

  logger.info(`\n===== ${options.length} SHIPPING OPTION(S) =====`);
  for (const o of options as any[]) {
    const countries = (o.service_zone?.geo_zones ?? [])
      .map((g: any) => g.country_code)
      .join(", ");
    logger.info(`\n▸ ${o.name}  [${o.price_type}]  zone=${o.service_zone?.name} (${countries})`);
    for (const p of o.prices ?? []) {
      logger.info(`    price ${p.id}: ${(p.amount as number).toFixed(2)} ${p.currency_code}`);
    }
  }
  logger.info("\n===== EIND =====\n");
}
