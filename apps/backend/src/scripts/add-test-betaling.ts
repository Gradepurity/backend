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
 * Verborgen €1-testproduct voor live betaal-tests (BANKpay+/Wallid).
 * Storefront-kant: hidden entry in forma data.ts (slug test-betaling) —
 * niet in listings/zoeken/sitemap/feed, pagina op noindex.
 * Idempotent: skipt als de handle al bestaat.
 *   npx medusa exec ./src/scripts/add-test-betaling.ts
 */
const SLUG = "test-betaling";

export default async function addTestBetaling({
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
  if (existing.some((x) => x.handle === SLUG)) {
    logger.info(`'${SLUG}' bestaat al — niets te doen.`);
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

  const { result: created } = await createProductsWorkflow(container).run({
    input: {
      products: [
        {
          title: "Testbetaling",
          handle: SLUG,
          description:
            "Intern testproduct van €1,00 om de betaalrails live te testen. Niet voor verkoop.",
          status: ProductStatus.PUBLISHED,
          shipping_profile_id: shippingProfile.id,
          options: [{ title: "Formaat", values: ["Standaard"] }],
          variants: [
            {
              title: "Standaard",
              sku: "TEST-BETALING",
              manage_inventory: true,
              options: { Formaat: "Standaard" },
              prices: [{ currency_code: "eur", amount: 1 }],
            },
          ],
          sales_channels: [{ id: defaultSalesChannel.id }],
          metadata: { internal_test: true },
        },
      ],
    },
  });
  logger.info(`Product aangemaakt: ${created.map((c) => c.handle).join(", ")}.`);

  const { data: inventoryItems } = await query.graph({
    entity: "inventory_item",
    fields: ["id", "sku", "location_levels.id"],
  });
  const testItem = inventoryItems.find(
    (i) => i.sku === "TEST-BETALING" && (!i.location_levels || i.location_levels.length === 0)
  );
  if (testItem) {
    await createInventoryLevelsWorkflow(container).run({
      input: {
        inventory_levels: [
          {
            location_id: stockLocation.id,
            stocked_quantity: 1000,
            inventory_item_id: testItem.id,
          },
        ],
      },
    });
    logger.info("Voorraad gezet (1000).");
  }

  logger.info("€1-testproduct toegevoegd. ✅");
}
