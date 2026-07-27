import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

/**
 * READ-ONLY: toon actuele voorraad per product/variant (stocked, gereserveerd
 * door open orders, en vrij beschikbaar).
 *   npx medusa exec ./src/scripts/toon-voorraad.ts
 */
export default async function toonVoorraad({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "handle",
      "status",
      "variants.title",
      "variants.inventory_items.inventory.location_levels.stocked_quantity",
      "variants.inventory_items.inventory.location_levels.reserved_quantity",
    ],
    pagination: { take: 200, skip: 0 } as any,
  });

  const rows: { naam: string; stocked: number; reserved: number }[] = [];
  for (const p of products as any[]) {
    if (p.status !== "published") continue;
    for (const v of p.variants ?? []) {
      const lvl = v.inventory_items?.[0]?.inventory?.location_levels?.[0];
      if (!lvl) continue;
      rows.push({
        naam: `${p.handle}${(p.variants?.length ?? 0) > 1 ? ` (${v.title})` : ""}`,
        stocked: Number(lvl.stocked_quantity),
        reserved: Number(lvl.reserved_quantity),
      });
    }
  }

  rows.sort((a, b) => (a.stocked - a.reserved) - (b.stocked - b.reserved) || a.naam.localeCompare(b.naam));
  for (const r of rows) {
    const vrij = r.stocked - r.reserved;
    const tag = r.stocked >= 900 ? " [oneindig]" : vrij <= 0 ? " ❌ UITVERKOCHT" : vrij <= 4 ? " ⚠️ LAAG" : "";
    logger.info(
      `${r.naam.padEnd(42)} plank=${String(r.stocked).padStart(4)} gereserveerd=${String(r.reserved).padStart(2)} vrij=${String(vrij).padStart(4)}${tag}`
    );
  }
}
