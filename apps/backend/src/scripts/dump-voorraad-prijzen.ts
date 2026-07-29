import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

/**
 * READ-ONLY: dump per gepubliceerde variant de voorraad + EUR-verkoopprijs als
 * JSON, voor marge/inkoop-analyses.
 *   npx medusa exec ./src/scripts/dump-voorraad-prijzen.ts
 */
export default async function dumpVoorraadPrijzen({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "title",
      "handle",
      "status",
      "variants.title",
      "variants.sku",
      "variants.prices.amount",
      "variants.prices.currency_code",
      "variants.prices.min_quantity",
      "variants.inventory_items.inventory.location_levels.stocked_quantity",
      "variants.inventory_items.inventory.location_levels.reserved_quantity",
    ],
    pagination: { take: 200, skip: 0 } as any,
  });

  const rows: any[] = [];
  for (const p of products as any[]) {
    if (p.status !== "published") continue;
    for (const v of p.variants ?? []) {
      const lvl = v.inventory_items?.[0]?.inventory?.location_levels?.[0];
      // basisprijs = EUR-prijs zonder staffel (min_quantity leeg of 1);
      // de overige EUR-prijzen zijn bulkkorting-staffels
      const eurPrices = (v.prices ?? []).filter((pr: any) => pr.currency_code === "eur");
      const base = eurPrices.find((pr: any) => !pr.min_quantity || Number(pr.min_quantity) <= 1) ?? eurPrices[0];
      rows.push({
        product: p.title,
        handle: p.handle,
        variant: v.title,
        sku: v.sku ?? null,
        prijs_eur: base ? Number(base.amount) : null,
        staffels_eur: eurPrices
          .filter((pr: any) => pr !== base)
          .map((pr: any) => `${pr.min_quantity}+: €${pr.amount}`),
        plank: lvl ? Number(lvl.stocked_quantity) : null,
        gereserveerd: lvl ? Number(lvl.reserved_quantity) : null,
      });
    }
  }
  logger.info("JSON_START\n" + JSON.stringify(rows, null, 1) + "\nJSON_END");
}
