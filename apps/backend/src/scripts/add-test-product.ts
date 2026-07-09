import { MedusaContainer } from "@medusajs/framework";
import {
  ContainerRegistrationKeys,
  ProductStatus,
} from "@medusajs/framework/utils";
import {
  createInventoryLevelsWorkflow,
  createProductsWorkflow,
} from "@medusajs/medusa/core-flows";

/**
 * Tijdelijk €1-testproduct (handle `test-product`) om de live betaalflow te
 * testen zonder echt artikel. Zelfde chirurgische aanpak als add-reta-cagri
 * (geen destructieve seed). Idempotent: skipt als de handle al bestaat.
 *
 * Draaien:  npx medusa exec ./src/scripts/add-test-product.ts
 * Opruimen na de test: product verwijderen via de Medusa-admin.
 */
const TARGET_SLUG = "test-product";

export default async function addTestProduct({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const { data: existing } = await query.graph({
    entity: "product",
    fields: ["id", "handle"],
  });
  if (existing.some((x) => x.handle === TARGET_SLUG)) {
    logger.info(`'${TARGET_SLUG}' bestaat al — niets te doen.`);
    return;
  }

  const { data: salesChannels } = await query.graph({
    entity: "sales_channel",
    fields: ["id", "name"],
  });
  const defaultSalesChannel =
    salesChannels.find((s) => s.name === "Default Sales Channel") ??
    salesChannels[0];

  const { data: shippingProfiles } = await query.graph({
    entity: "shipping_profile",
    fields: ["id"],
  });
  const shippingProfile = shippingProfiles[0];

  const { data: stockLocations } = await query.graph({
    entity: "stock_location",
    fields: ["id"],
  });
  const stockLocation = stockLocations[0];

  if (!defaultSalesChannel || !shippingProfile || !stockLocation) {
    throw new Error("Basis-seed ontbreekt (sales channel / shipping / stock).");
  }

  const { data: cats } = await query.graph({
    entity: "product_category",
    fields: ["id", "handle"],
  });
  const categoryId = cats.find((c) => c.handle === "accessoires")?.id;

  const { result: created } = await createProductsWorkflow(container).run({
    input: {
      products: [
        {
          title: "Testproduct",
          handle: TARGET_SLUG,
          description:
            "Tijdelijk testproduct van €1 om de checkout en betaalflow live te testen. Geen echt artikel; er wordt niets geleverd.",
          status: ProductStatus.PUBLISHED,
          category_ids: categoryId ? [categoryId] : [],
          shipping_profile_id: shippingProfile.id,
          options: [{ title: "Formaat", values: ["Standaard"] }],
          variants: [
            {
              title: "Standaard",
              sku: "TEST-PRODUCT-STANDAARD",
              manage_inventory: true,
              options: { Formaat: "Standaard" },
              prices: [{ currency_code: "eur", amount: 1 }],
            },
          ],
          sales_channels: [{ id: defaultSalesChannel.id }],
          metadata: { hub: "accessoires", test_product: true },
        },
      ],
    },
  });
  logger.info(`Product aangemaakt: ${created.map((c) => c.handle).join(", ")}.`);

  // inventory level voor de nieuwe variant
  const { data: inventoryItems } = await query.graph({
    entity: "inventory_item",
    fields: ["id", "location_levels.id"],
  });
  const itemsWithoutLevel = inventoryItems.filter(
    (i) => !i.location_levels || i.location_levels.length === 0
  );
  if (itemsWithoutLevel.length) {
    await createInventoryLevelsWorkflow(container).run({
      input: {
        inventory_levels: itemsWithoutLevel.map((item) => ({
          location_id: stockLocation.id,
          stocked_quantity: 1000,
          inventory_item_id: item.id,
        })),
      },
    });
    logger.info(`Voorraad gezet voor ${itemsWithoutLevel.length} variant(en).`);
  }

  logger.info("€1-testproduct toegevoegd aan live catalogus. ✅");
}
