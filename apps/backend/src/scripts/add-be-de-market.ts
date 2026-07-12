import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import {
  updateRegionsWorkflow,
  createTaxRegionsWorkflow,
} from "@medusajs/medusa/core-flows";

/**
 * Maakt België en Duitsland volledig bestelbaar (regio + tax-regio +
 * verzendzone). De seed gaf de Europe-regio wel 'de' maar geen 'be'; de
 * verzendzone kreeg later wel 'be' (update-shipping-flat) maar geen 'de'.
 * Dit script trekt beide landen op alle drie de niveaus gelijk, zodat de
 * storefront-checkout met country_code 'be' of 'de' een cart kan afronden.
 *
 * Idempotent en veilig herhaalbaar:
 *   npx medusa exec ./src/scripts/add-be-de-market.ts
 */
const COUNTRIES = ["be", "de"] as const;

export default async function addBeDeMarket({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  // 1. Region: ontbrekende landen aan de Europe-regio toevoegen.
  const { data: regions } = await query.graph({
    entity: "region",
    fields: ["id", "name", "countries.iso_2"],
  });
  const europe = regions.find((r) => r.name === "Europe") ?? regions[0];
  const current = (europe.countries ?? []).map((c: any) => c.iso_2);
  const missing = COUNTRIES.filter((c) => !current.includes(c));
  if (missing.length) {
    await updateRegionsWorkflow(container).run({
      input: {
        selector: { id: europe.id },
        update: { countries: [...current, ...missing] },
      },
    });
    logger.info(
      `Regio '${europe.name}': ${missing.join(",").toUpperCase()} toegevoegd. Landen nu: ${[...current, ...missing].join(",")}`
    );
  } else {
    logger.info(`Regio '${europe.name}' bevat BE en DE al (${current.join(",")}).`);
  }

  // 2. Tax regions.
  for (const country of COUNTRIES) {
    try {
      await createTaxRegionsWorkflow(container).run({
        input: [{ country_code: country, provider_id: "tp_system" }] as any,
      });
      logger.info(`Tax region ${country.toUpperCase()} aangemaakt.`);
    } catch (e: any) {
      logger.info(`Tax region ${country.toUpperCase()} bestond al of overgeslagen: ${e.message}`);
    }
  }

  // 3. Fulfillment service zone.
  const fulfillment = container.resolve(Modules.FULFILLMENT);
  const zones = await fulfillment.listServiceZones({}, { relations: ["geo_zones"] });
  const zone = zones[0];
  const existing = (zone.geo_zones ?? []).map((g: any) => g.country_code);
  const missingZone = COUNTRIES.filter((c) => !existing.includes(c));
  if (missingZone.length) {
    await fulfillment.updateServiceZones(zone.id, {
      geo_zones: [
        ...(zone.geo_zones ?? []).map((g: any) => ({
          id: g.id,
          country_code: g.country_code,
          type: g.type,
        })),
        ...missingZone.map((c) => ({ country_code: c, type: "country" as const })),
      ],
    } as any);
    logger.info(`Verzendzone '${zone.name}': ${missingZone.join(",").toUpperCase()} toegevoegd.`);
  } else {
    logger.info(`Verzendzone '${zone.name}' bevat BE en DE al (${existing.join(",")}).`);
  }

  logger.info("BE + DE markt klaar. ✅");
}
