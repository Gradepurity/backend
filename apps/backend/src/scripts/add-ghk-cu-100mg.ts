import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import {
  createProductVariantsWorkflow,
  createInventoryLevelsWorkflow,
  updateProductOptionsWorkflow,
} from "@medusajs/medusa/core-flows";

/**
 * Voegt de 100 mg-variant toe aan het bestaande GHK-Cu-product in de live
 * Medusa-catalogus (die had alleen 50 mg). Non-destructief: raakt de bestaande
 * 50 mg-variant + voorraad niet aan. Idempotent: skip als 100 mg al bestaat.
 */
const HANDLE = "ghk-cu";
const VARIANT_TITLE = "100 mg vial";
const OPTION_TITLE = "Formaat";
const PRICE_EUR = 49.95;
const STOCK = 1000;

export default async function addGhkCu100({
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
      "variants.id",
      "variants.title",
      "options.id",
      "options.title",
      "options.values.value",
    ],
    filters: { handle: HANDLE },
  });
  const product = products[0];
  if (!product) throw new Error(`Product ${HANDLE} niet gevonden.`);

  if (product.variants?.some((v: { title: string }) => v.title === VARIANT_TITLE)) {
    logger.info(`'${VARIANT_TITLE}' bestaat al — niets te doen.`);
    return;
  }

  // De optie-waarde moet bestaan vóór we er een variant aan koppelen.
  const option = product.options?.find(
    (o: { title: string }) => o.title === OPTION_TITLE
  );
  if (!option) throw new Error(`Optie '${OPTION_TITLE}' niet gevonden.`);
  const existingValues: string[] = (option.values ?? []).map(
    (v: { value: string }) => v.value
  );
  if (!existingValues.includes(VARIANT_TITLE)) {
    await updateProductOptionsWorkflow(container).run({
      input: {
        selector: { id: option.id },
        update: { values: [...existingValues, VARIANT_TITLE] },
      },
    });
    logger.info(`Optie-waarde '${VARIANT_TITLE}' toegevoegd aan '${OPTION_TITLE}'.`);
  }

  await createProductVariantsWorkflow(container).run({
    input: {
      product_variants: [
        {
          product_id: product.id,
          title: VARIANT_TITLE,
          sku: "GHK-CU-100MG",
          manage_inventory: true,
          options: { [OPTION_TITLE]: VARIANT_TITLE },
          prices: [{ currency_code: "eur", amount: PRICE_EUR }],
        },
      ],
    },
  });
  logger.info(`Variant '${VARIANT_TITLE}' aangemaakt voor ${HANDLE}.`);

  const { data: stockLocations } = await query.graph({
    entity: "stock_location",
    fields: ["id"],
  });
  const stockLocation = stockLocations[0];

  const { data: inventoryItems } = await query.graph({
    entity: "inventory_item",
    fields: ["id", "location_levels.id"],
  });
  const withoutLevel = inventoryItems.filter(
    (i: { location_levels?: unknown[] }) =>
      !i.location_levels || i.location_levels.length === 0
  );
  if (withoutLevel.length) {
    await createInventoryLevelsWorkflow(container).run({
      input: {
        inventory_levels: withoutLevel.map((item: { id: string }) => ({
          location_id: stockLocation.id,
          stocked_quantity: STOCK,
          inventory_item_id: item.id,
        })),
      },
    });
    logger.info(`Voorraad gezet voor ${withoutLevel.length} variant(en).`);
  }

  logger.info("GHK-Cu 100 mg live gezet. ✅");
}
