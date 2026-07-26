import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { updateInventoryLevelsWorkflow } from "@medusajs/medusa/core-flows";
import { pingStockRevalidate } from "../lib/revalidate-stock";

/**
 * Voorraad-schakelaar per VARIANT (set-stock.ts zet alle varianten van een
 * product tegelijk). Matcht de variant op een substring van de titel.
 *
 * Gebruik:
 *   npx medusa exec ./src/scripts/set-stock-variant.ts <aantal> <slug> <variant-titel-substring>
 *   npx medusa exec ./src/scripts/set-stock-variant.ts 10 ghk-cu "50 mg"
 */
export default async function setStockVariant({
  container,
  args,
}: {
  container: MedusaContainer;
  args: string[];
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const qty = Number.parseInt(args?.[0] ?? "", 10);
  const slug = args?.[1];
  const titleMatch = args?.slice(2).join(" ");

  if (Number.isNaN(qty) || !slug || !titleMatch) {
    logger.error(
      'Gebruik: medusa exec ./src/scripts/set-stock-variant.ts <aantal> <slug> "<variant-titel>"'
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
      "variants.inventory_items.inventory.location_levels.reserved_quantity",
    ],
    filters: { handle: [slug] },
  });

  if (!products.length) {
    logger.error(`Product met handle "${slug}" niet gevonden`);
    return;
  }

  const updates: {
    inventory_item_id: string;
    location_id: string;
    stocked_quantity: number;
  }[] = [];

  for (const p of products) {
    for (const v of p.variants ?? []) {
      if (!v.title?.toLowerCase().includes(titleMatch.toLowerCase())) continue;
      for (const ii of v.inventory_items ?? []) {
        const inv = ii?.inventory;
        if (!inv) continue;
        for (const lvl of inv.location_levels ?? []) {
          if (!lvl) continue;
          updates.push({
            inventory_item_id: inv.id,
            location_id: lvl.location_id,
            stocked_quantity: qty,
          });
          logger.info(
            `${p.handle} / ${v.title}: ${lvl.stocked_quantity} (reserved ${lvl.reserved_quantity}) -> ${qty}`
          );
        }
      }
    }
  }

  if (!updates.length) {
    logger.warn(`Geen variant met "${titleMatch}" in titel gevonden op ${slug}`);
    return;
  }

  await updateInventoryLevelsWorkflow(container).run({
    input: { updates },
  });
  logger.info(`Klaar: ${updates.length} niveau(s) bijgewerkt. ✅`);

  await pingStockRevalidate(logger);
}
