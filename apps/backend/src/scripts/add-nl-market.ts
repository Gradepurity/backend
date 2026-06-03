import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import {
  updateRegionsWorkflow,
  createTaxRegionsWorkflow,
} from "@medusajs/medusa/core-flows";

export default async function addNlMarket({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  // 1. Region: add 'nl' to Europe region countries
  const { data: regions } = await query.graph({
    entity: "region",
    fields: ["id", "name", "countries.iso_2"],
  });
  const europe = regions.find((r) => r.name === "Europe") ?? regions[0];
  const current = (europe.countries ?? []).map((c: any) => c.iso_2);
  if (!current.includes("nl")) {
    await updateRegionsWorkflow(container).run({
      input: { selector: { id: europe.id }, update: { countries: [...current, "nl"] } },
    });
    logger.info(`Regio '${europe.name}': NL toegevoegd. Landen nu: ${[...current, "nl"].join(",")}`);
  } else {
    logger.info("Regio bevat NL al.");
  }

  // 2. Tax region for NL
  try {
    await createTaxRegionsWorkflow(container).run({
      input: [{ country_code: "nl", provider_id: "tp_system" }] as any,
    });
    logger.info("Tax region NL aangemaakt.");
  } catch (e: any) {
    logger.info("Tax region NL bestond al of overgeslagen: " + e.message);
  }

  // 3. Fulfillment service zone: add 'nl' geo zone
  const fulfillment = container.resolve(Modules.FULFILLMENT);
  const zones = await fulfillment.listServiceZones(
    {},
    { relations: ["geo_zones"] }
  );
  const zone = zones[0];
  const existing = (zone.geo_zones ?? []).map((g: any) => g.country_code);
  if (!existing.includes("nl")) {
    await fulfillment.updateServiceZones(zone.id, {
      geo_zones: [
        ...(zone.geo_zones ?? []).map((g: any) => ({ id: g.id, country_code: g.country_code, type: g.type })),
        { country_code: "nl", type: "country" },
      ],
    } as any);
    logger.info(`Verzendzone '${zone.name}': NL toegevoegd.`);
  } else {
    logger.info("Verzendzone bevat NL al.");
  }

  logger.info("NL-markt klaar. ✅");
}
