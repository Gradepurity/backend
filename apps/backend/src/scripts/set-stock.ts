import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import {
  createInventoryLevelsWorkflow,
  updateInventoryLevelsWorkflow,
} from "@medusajs/medusa/core-flows";

/**
 * Voorraad-schakelaar per product. Geen aantallen bijhouden: gebruik 0 om iets
 * op "uitverkocht" te zetten en een ruim getal (bv. 1000) om het terug op
 * voorraad te zetten. De storefront leest dit live (zie forma/src/lib/stock.ts),
 * dus de wijziging is binnen ~1 min site-breed zichtbaar — geen deploy nodig.
 *
 * Gebruik:
 *   npx medusa exec ./src/scripts/set-stock.ts 0 ghrp-2 melanotan-2 nad-plus
 *   npx medusa exec ./src/scripts/set-stock.ts 1000 ghrp-2
 */
export default async function setStock({
  container,
  args,
}: {
  container: MedusaContainer;
  args: string[];
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const qty = Number.parseInt(args?.[0] ?? "", 10);
  const slugs = (args ?? []).slice(1);

  if (Number.isNaN(qty) || slugs.length === 0) {
    logger.error(
      "Gebruik: medusa exec ./src/scripts/set-stock.ts <aantal> <slug> [slug...]"
    );
    return;
  }

  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "handle",
      "variants.title",
      "variants.inventory_items.inventory.id",
      "variants.inventory_items.inventory.location_levels.location_id",
      "variants.inventory_items.inventory.location_levels.stocked_quantity",
    ],
    filters: { handle: slugs },
  });

  const found = new Set(products.map((p) => p.handle));
  const missing = slugs.filter((s) => !found.has(s));
  if (missing.length) {
    logger.warn(`Niet gevonden in Medusa: ${missing.join(", ")}`);
  }
  if (!products.length) return;

  const { data: stockLocations } = await query.graph({
    entity: "stock_location",
    fields: ["id"],
  });
  const defaultLocationId = stockLocations[0]?.id;

  const updates: {
    inventory_item_id: string;
    location_id: string;
    stocked_quantity: number;
  }[] = [];
  const creates: {
    inventory_item_id: string;
    location_id: string;
    stocked_quantity: number;
  }[] = [];

  for (const p of products) {
    for (const v of p.variants ?? []) {
      for (const ii of v.inventory_items ?? []) {
        const inv = ii?.inventory;
        if (!inv) continue;
        const levels = inv.location_levels ?? [];
        if (levels.length === 0 && defaultLocationId) {
          creates.push({
            inventory_item_id: inv.id,
            location_id: defaultLocationId,
            stocked_quantity: qty,
          });
          continue;
        }
        for (const lvl of levels) {
          if (!lvl) continue;
          updates.push({
            inventory_item_id: inv.id,
            location_id: lvl.location_id,
            stocked_quantity: qty,
          });
        }
        logger.info(`${p.handle} / ${v.title} -> ${qty}`);
      }
    }
  }

  if (creates.length) {
    await createInventoryLevelsWorkflow(container).run({
      input: { inventory_levels: creates },
    });
  }
  if (updates.length) {
    await updateInventoryLevelsWorkflow(container).run({
      input: { updates },
    });
  }

  const label = qty <= 0 ? "UITVERKOCHT" : `voorraad ${qty}`;
  logger.info(
    `Klaar: ${updates.length + creates.length} niveau(s) op ${label} gezet. ✅`
  );
}
