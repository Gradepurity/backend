import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

/**
 * Read-only: dumpt de ruwe adresvelden (shipping + billing) van één order,
 * veld voor veld, om onduidelijke naam/straat-invoer te ontwarren.
 *   npx medusa exec ./src/scripts/adres-raw.ts <display_id>
 */
export default async function adresRaw({
  container,
  args,
}: {
  container: MedusaContainer;
  args?: string[];
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const displayId = Number((args ?? [])[0]);
  if (!displayId) {
    logger.error("Gebruik: npx medusa exec ./src/scripts/adres-raw.ts <display_id>");
    return;
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "display_id",
      "email",
      "shipping_address.*",
      "billing_address.*",
    ],
    filters: { display_id: displayId } as any,
  });

  const o = (orders as any[])[0];
  if (!o) {
    logger.error(`Order #${displayId} niet gevonden.`);
    return;
  }

  const dump = (label: string, a: any) => {
    if (!a) {
      logger.info(`${label}: (geen)`);
      return;
    }
    logger.info(`--- ${label} ---`);
    for (const veld of [
      "first_name",
      "last_name",
      "company",
      "address_1",
      "address_2",
      "postal_code",
      "city",
      "province",
      "country_code",
      "phone",
    ]) {
      logger.info(`  ${veld}: ${JSON.stringify(a[veld] ?? null)}`);
    }
  };

  logger.info(`\n===== RUWE ADRESVELDEN ORDER #${o.display_id} (${o.email}) =====`);
  dump("shipping_address", o.shipping_address);
  dump("billing_address", o.billing_address);
  logger.info("===== EIND =====\n");
}
