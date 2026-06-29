import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { updateInventoryLevelsWorkflow } from "@medusajs/medusa/core-flows";

/**
 * Sets stocked_quantity to 0 for products that went out of stock, so the
 * storefront and admin both reflect "uitverkocht". Idempotent: re-running is
 * harmless (it just writes 0 again). Matches the storefront soldOut flags in
 * forma/src/lib/data.ts.
 */
const TARGET_SLUGS = ["ghrp-2", "melanotan-2", "nad-plus"];

export default async function setStockZero({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id",
      "handle",
      "title",
      "variants.id",
      "variants.title",
      "variants.inventory_items.inventory.id",
      "variants.inventory_items.inventory.location_levels.id",
      "variants.inventory_items.inventory.location_levels.location_id",
      "variants.inventory_items.inventory.location_levels.stocked_quantity",
      "variants.inventory_items.inventory.location_levels.reserved_quantity",
    ],
    filters: { handle: TARGET_SLUGS },
  });

  if (!products.length) {
    logger.warn(
      `Geen producten gevonden voor handles: ${TARGET_SLUGS.join(", ")}.`
    );
    return;
  }

  const updates: {
    inventory_item_id: string;
    location_id: string;
    stocked_quantity: number;
  }[] = [];

  for (const p of products) {
    for (const v of p.variants ?? []) {
      for (const ii of v.inventory_items ?? []) {
        const inv = ii?.inventory;
        if (!inv) continue;
        for (const lvl of inv.location_levels ?? []) {
          if (!lvl) continue;
          updates.push({
            inventory_item_id: inv.id,
            location_id: lvl.location_id,
            stocked_quantity: 0,
          });
          logger.info(
            `${p.handle} / ${v.title}: ${lvl.stocked_quantity} -> 0 ` +
              `(gereserveerd: ${lvl.reserved_quantity ?? 0})`
          );
        }
      }
    }
  }

  if (!updates.length) {
    logger.warn("Geen voorraadniveaus gevonden om bij te werken.");
    return;
  }

  await updateInventoryLevelsWorkflow(container).run({
    input: { updates },
  });

  logger.info(
    `Voorraad op 0 gezet voor ${updates.length} niveau(s) over ${products.length} product(en). ✅`
  );
}
