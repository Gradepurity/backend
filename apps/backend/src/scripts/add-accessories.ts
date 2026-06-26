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
 * Surgical add of the injectable-peptide accessories (configurator add-ons on
 * the PDP) to the live catalog. Each handle must match the storefront slug in
 * forma/src/lib/addons.ts so the cart resolves them at checkout.
 *
 * Idempotent: skips any handle that already exists. Run with:
 *   npx medusa exec ./src/scripts/add-accessories.ts
 *
 * ── Keep prices in sync with forma/src/lib/addons.ts (priceCents).
 */
type Accessory = {
  handle: string;
  title: string;
  description: string;
  priceCents: number;
};

const ACCESSORIES: Accessory[] = [
  {
    handle: "bacteriostatisch-water-10ml",
    title: "Bacteriostatisch water 10ml",
    description:
      "10ml bacteriostatisch water voor reconstitutie. Uitsluitend voor laboratoriumonderzoek.",
    priceCents: 495,
  },
  {
    handle: "insulinenaalden-1ml-10",
    title: "Insulinenaalden 10× 1ml",
    description: "10 steriele insulinespuiten 1ml. Uitsluitend voor laboratoriumonderzoek.",
    priceCents: 495,
  },
  {
    handle: "insulinenaalden-05ml-10",
    title: "Insulinenaalden 10× 0,5ml",
    description:
      "10 steriele insulinespuiten 0,5ml. Uitsluitend voor laboratoriumonderzoek.",
    priceCents: 495,
  },
  {
    handle: "alcohol-swabs-10",
    title: "Alcohol swabs (10×)",
    description: "10 alcohol-doekjes voor desinfectie.",
    priceCents: 295,
  },
];

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

export default async function addAccessories({
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
  const existingHandles = new Set(existing.map((x) => x.handle));

  const toCreate = ACCESSORIES.filter((a) => !existingHandles.has(a.handle));
  if (!toCreate.length) {
    logger.info("Alle accessoires bestaan al — niets te doen.");
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

  const productInputs = toCreate.map((a) => ({
    title: a.title,
    handle: a.handle,
    description: a.description,
    status: ProductStatus.PUBLISHED,
    shipping_profile_id: shippingProfile.id,
    options: [{ title: "Formaat", values: ["Standaard"] }],
    variants: [
      {
        title: "Standaard",
        sku: slugify(a.handle).toUpperCase(),
        manage_inventory: true,
        options: { Formaat: "Standaard" },
        prices: [{ currency_code: "eur", amount: a.priceCents / 100 }],
      },
    ],
    sales_channels: [{ id: defaultSalesChannel.id }],
    metadata: { accessory: true },
  }));

  const { result: created } = await createProductsWorkflow(container).run({
    input: { products: productInputs },
  });
  logger.info(
    `Accessoires aangemaakt: ${created.map((c) => c.handle).join(", ")}.`
  );

  // Inventory levels for the new variants only.
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

  logger.info("Accessoires toegevoegd aan live catalogus. ✅");
}
