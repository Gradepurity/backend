import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { updateInventoryLevelsWorkflow } from "@medusajs/medusa/core-flows";
import { pingStockRevalidate } from "../lib/revalidate-stock";

/**
 * Eenmalige omschakeling naar ECHTE voorraadaantallen (telling 23-07 uit
 * VOORRAAD.md, minus verkopen/cadeaus/Janoshik-samples t/m 27-07).
 *
 * Doet twee dingen:
 * 1) Hersynchroniseert reserved_quantity met de werkelijke reservation_items
 *    (drift van geannuleerde orders bij semaglutide/cagrisema/bpc-157).
 * 2) Zet stocked_quantity op de echte plankvoorraad. Open orders blijven als
 *    reservering staan en tellen bij verzending vanzelf af.
 *
 * Oneindig-items (retatrutide, mots-c, bac water) en accessoires blijven op
 * het symbolische hoge getal.
 *   npx medusa exec ./src/scripts/set-real-stock-20260727.ts
 */

// (handle, variant-titel) -> echte plankvoorraad per 27-07
const REAL_COUNTS: Array<[string, string, number]> = [
  ["snap-8", "10 mg vial", 5],
  ["cjc-1295-no-dac", "5 mg vial", 8],
  ["cjc-1295-no-dac", "2 mg vial", 9],
  ["epitalon", "10 mg vial", 8],
  ["bpc-157", "10 mg vial", 7],
  ["ghk-cu", "50 mg vial", 0],
  ["ghk-cu", "100 mg vial", 0],
  ["tb-500", "5 mg vial", 7],
  ["semaglutide", "10 mg vial", 6],
  ["ipamorelin", "10 mg vial", 8],
  ["sermorelin", "10 mg vial", 10],
  ["nad-plus", "500 mg vial", 4],
  ["survodutide", "10 mg vial", 10],
  ["tesamorelin", "5 mg vial", 7],
  ["bpc-157-tb-500", "10 mg vial", 10],
  ["ghrp-2", "10 mg vial", 10],
  ["cagrilintide", "5 mg vial", 8],
  ["ss-31", "10 mg vial", 10],
  ["selank", "5 mg vial", 10],
  ["cagrisema", "Standaard", 10],
  ["pt-141", "10 mg vial", 10],
  ["igf-1-lr3", "1 mg vial", 8],
  ["5-amino-1mq", "10 mg vial", 10],
  ["semax", "5 mg vial", 10],
  ["hmg", "75 IU vial", 10],
  ["melanotan-2", "10 mg vial", 10],
  ["ghrp-6", "10 mg vial", 10],
  ["ahk-cu", "20 mg vial", 10],
  ["kpv", "10 mg vial", 7],
  ["thymosin-alpha-1", "10 mg vial", 10],
  ["aod9604", "5 mg vial", 20],
  ["klow", "80 mg vial", 10],
  ["cjc-1295-ipamorelin", "10 mg vial", 10],
];

export default async function setRealStock({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as any;

  // ---- Stap 1: reserved_quantity hersynchroniseren met reservation_items ----
  const drift = await pg.raw(`
    SELECT il.id, ii.sku, il.reserved_quantity,
           COALESCE(sub.total, 0) AS echt
    FROM inventory_level il
    JOIN inventory_item ii ON ii.id = il.inventory_item_id
    LEFT JOIN (
      SELECT inventory_item_id, SUM(quantity) AS total
      FROM reservation_item
      WHERE deleted_at IS NULL
      GROUP BY inventory_item_id
    ) sub ON sub.inventory_item_id = il.inventory_item_id
    WHERE il.deleted_at IS NULL
      AND il.reserved_quantity <> COALESCE(sub.total, 0)
  `);

  if (drift.rows.length === 0) {
    logger.info("Geen reserved-drift gevonden.");
  }
  for (const row of drift.rows) {
    logger.info(`DRIFT ${row.sku}: reserved ${row.reserved_quantity} -> ${row.echt}`);
  }
  if (drift.rows.length > 0) {
    await pg.raw(`
      UPDATE inventory_level il
      SET reserved_quantity = COALESCE(sub.total, 0),
          raw_reserved_quantity = jsonb_build_object(
            'value', COALESCE(sub.total, 0)::text, 'precision', 20
          )
      FROM inventory_level il2
      LEFT JOIN (
        SELECT inventory_item_id, SUM(quantity) AS total
        FROM reservation_item
        WHERE deleted_at IS NULL
        GROUP BY inventory_item_id
      ) sub ON sub.inventory_item_id = il2.inventory_item_id
      WHERE il.id = il2.id
        AND il.deleted_at IS NULL
        AND il.reserved_quantity <> COALESCE(sub.total, 0)
    `);
    logger.info(`Reserved-drift gefixt op ${drift.rows.length} niveau(s).`);
  }

  // ---- Stap 2: echte plankvoorraad invoeren ----
  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "handle",
      "variants.title",
      "variants.inventory_items.inventory.id",
      "variants.inventory_items.inventory.location_levels.location_id",
      "variants.inventory_items.inventory.location_levels.stocked_quantity",
    ],
    filters: { handle: [...new Set(REAL_COUNTS.map(([h]) => h))] },
  });

  const updates: { inventory_item_id: string; location_id: string; stocked_quantity: number }[] = [];
  const missing: string[] = [];

  for (const [handle, variantTitle, qty] of REAL_COUNTS) {
    const p = (products as any[]).find((x) => x.handle === handle);
    const v = p?.variants?.find((x: any) => x.title === variantTitle);
    const inv = v?.inventory_items?.[0]?.inventory;
    const lvl = inv?.location_levels?.[0];
    if (!inv || !lvl) {
      missing.push(`${handle} / ${variantTitle}`);
      continue;
    }
    updates.push({
      inventory_item_id: inv.id,
      location_id: lvl.location_id,
      stocked_quantity: qty,
    });
    logger.info(`${handle} / ${variantTitle}: ${lvl.stocked_quantity} -> ${qty}`);
  }

  if (missing.length) {
    logger.error(`NIET GEVONDEN (niet aangepast): ${missing.join(", ")}`);
  }

  await updateInventoryLevelsWorkflow(container).run({ input: { updates } });
  logger.info(`Klaar: ${updates.length} producten op echte voorraad gezet. ✅`);

  await pingStockRevalidate(logger);
}
