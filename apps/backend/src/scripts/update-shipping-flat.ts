import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { updateShippingOptionsWorkflow } from "@medusajs/medusa/core-flows";

/**
 * Trekt de verzending gelijk met Google Merchant Center + de voorwaarden:
 *   - €7,95 vast tarief
 *   - gratis (€0) vanaf een ordertotaal van €125
 *   - voor alle EU-zonelanden, inclusief België (dat nog niet in de zone zat)
 *
 * Idempotent en veilig herhaalbaar:
 *   npx medusa exec ./src/scripts/update-shipping-flat.ts
 */
const FLAT_EUR = 7.95;
const FREE_FROM_EUR = 125;

export default async function updateShippingFlat({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const fulfillment = container.resolve(Modules.FULFILLMENT);

  // 1. België aan de verzendzone toevoegen (indien nog niet aanwezig).
  const zones = await fulfillment.listServiceZones({}, { relations: ["geo_zones"] });
  const zone = zones[0];
  const countries = (zone.geo_zones ?? []).map((g: any) => g.country_code);
  if (!countries.includes("be")) {
    await fulfillment.updateServiceZones(zone.id, {
      geo_zones: [
        ...(zone.geo_zones ?? []).map((g: any) => ({
          id: g.id,
          country_code: g.country_code,
          type: g.type,
        })),
        { country_code: "be", type: "country" },
      ],
    } as any);
    logger.info(`Verzendzone '${zone.name}': België toegevoegd.`);
  } else {
    logger.info(`Verzendzone '${zone.name}' bevat België al.`);
  }

  // 2. Alle shipping-opties op €6,95 zetten met een gratis-tier vanaf €100.
  const { data: options } = await query.graph({
    entity: "shipping_option",
    fields: ["id", "name"],
  });

  for (const o of options as any[]) {
    await updateShippingOptionsWorkflow(container).run({
      input: [
        {
          id: o.id,
          prices: [
            { currency_code: "eur", amount: FLAT_EUR },
            {
              currency_code: "eur",
              amount: 0,
              rules: [{ attribute: "item_total", operator: "gte", value: FREE_FROM_EUR }],
            },
          ],
        },
      ],
    });
    logger.info(`'${o.name}': €${FLAT_EUR.toFixed(2)} flat, gratis vanaf €${FREE_FROM_EUR}.`);
  }

  logger.info("Verzending gelijkgetrokken. ✅");
}
