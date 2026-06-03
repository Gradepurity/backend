import { MedusaContainer } from "@medusajs/framework";
import {
  ContainerRegistrationKeys,
  ProductStatus,
} from "@medusajs/framework/utils";
import {
  createInventoryLevelsWorkflow,
  createProductCategoriesWorkflow,
  createProductsWorkflow,
  deleteProductCategoriesWorkflow,
  deleteProductsWorkflow,
} from "@medusajs/medusa/core-flows";
import { readFileSync } from "fs";
import { join } from "path";

type CatalogVariant = { id: string; name: string; priceCents: number; comparePriceCents?: number };
type CatalogPeptide = Record<string, unknown>;
type CatalogProduct = {
  id: string;
  slug: string;
  hub: string;
  name: string;
  code?: string;
  tagline: string;
  shortDescription: string;
  longDescription: string;
  priceCents: number;
  comparePriceCents?: number;
  researchOnly?: boolean;
  badges: string[];
  benefits: string[];
  variants?: CatalogVariant[];
  peptide?: CatalogPeptide;
  bundle?: { name: string; vialMg: number }[];
};
type CatalogHub = { slug: string; name: string; tagline?: string };
type Catalog = { hubs: CatalogHub[]; products: CatalogProduct[] };

// Demo data shipped by the Medusa starter seed — removed so only GradePurity remains.
const DEMO_PRODUCT_HANDLES = ["t-shirt", "sweatshirt", "sweatpants", "shorts"];
const DEMO_CATEGORY_NAMES = ["Shirts", "Sweatshirts", "Pants", "Merch"];

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

export default async function seedGradePurity({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const catalog: Catalog = JSON.parse(
    readFileSync(join(process.cwd(), "src/scripts/catalog.json"), "utf-8")
  );
  logger.info(
    `GradePurity seed: ${catalog.products.length} producten, ${catalog.hubs.length} hubs.`
  );

  // --- references created by the starter seed ---
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
    throw new Error(
      "Basis-seed ontbreekt (sales channel / shipping profile / stock location). Draai eerst de starter-seed."
    );
  }

  // --- remove demo products + categories ---
  const { data: existingProducts } = await query.graph({
    entity: "product",
    fields: ["id", "handle"],
  });
  const demoIds = existingProducts
    .filter((p) => DEMO_PRODUCT_HANDLES.includes(p.handle))
    .map((p) => p.id);
  // Also clear any GradePurity products from a previous run (idempotent re-seed).
  const gpHandles = new Set(catalog.products.map((p) => p.slug));
  const staleGpIds = existingProducts
    .filter((p) => gpHandles.has(p.handle))
    .map((p) => p.id);
  const toDelete = [...new Set([...demoIds, ...staleGpIds])];
  if (toDelete.length) {
    await deleteProductsWorkflow(container).run({ input: { ids: toDelete } });
    logger.info(`Verwijderd: ${toDelete.length} bestaande producten (demo + oude seed).`);
  }

  const { data: existingCats } = await query.graph({
    entity: "product_category",
    fields: ["id", "name"],
  });
  const demoCatIds = existingCats
    .filter((c) => DEMO_CATEGORY_NAMES.includes(c.name))
    .map((c) => c.id);
  if (demoCatIds.length) {
    await deleteProductCategoriesWorkflow(container).run({ input: demoCatIds });
    logger.info(`Verwijderd: ${demoCatIds.length} demo-categorieën.`);
  }

  // --- categories per hub ---
  const { data: catsAfter } = await query.graph({
    entity: "product_category",
    fields: ["id", "name", "handle"],
  });
  const existingByHandle = new Map(catsAfter.map((c) => [c.handle, c.id]));
  const hubsToCreate = catalog.hubs.filter((h) => !existingByHandle.has(h.slug));
  if (hubsToCreate.length) {
    const { result: createdCats } = await createProductCategoriesWorkflow(
      container
    ).run({
      input: {
        product_categories: hubsToCreate.map((h) => ({
          name: h.name,
          handle: h.slug,
          is_active: true,
        })),
      },
    });
    createdCats.forEach((c) => existingByHandle.set(c.handle, c.id));
    logger.info(`Categorieën aangemaakt: ${createdCats.length}.`);
  }

  // --- build product inputs ---
  const productsInput = catalog.products.map((p) => {
    const variants: CatalogVariant[] =
      p.variants && p.variants.length
        ? p.variants
        : [{ id: `${p.id}-default`, name: "Standaard", priceCents: p.priceCents }];

    const usedSkus = new Set<string>();
    const mkSku = (variantName: string) => {
      const base = `${p.code ?? p.slug}-${variantName}`;
      let sku = slugify(base).toUpperCase();
      let n = 2;
      while (usedSkus.has(sku)) sku = `${slugify(base).toUpperCase()}-${n++}`;
      usedSkus.add(sku);
      return sku;
    };

    const optionValues = variants.map((v) => v.name);

    return {
      title: p.name,
      handle: p.slug,
      description: p.longDescription || p.shortDescription,
      status: ProductStatus.PUBLISHED,
      category_ids: existingByHandle.has(p.hub)
        ? [existingByHandle.get(p.hub)!]
        : [],
      shipping_profile_id: shippingProfile.id,
      options: [{ title: "Formaat", values: optionValues }],
      variants: variants.map((v) => ({
        title: v.name,
        sku: mkSku(v.name),
        manage_inventory: true,
        options: { Formaat: v.name },
        prices: [{ currency_code: "eur", amount: v.priceCents / 100 }],
      })),
      sales_channels: [{ id: defaultSalesChannel.id }],
      metadata: {
        gp_code: p.code ?? null,
        tagline: p.tagline ?? null,
        badges: p.badges ?? [],
        benefits: p.benefits ?? [],
        research_only: p.researchOnly ?? false,
        hub: p.hub,
        peptide: p.peptide ?? null,
        bundle: p.bundle ?? null,
        compare_price_cents: p.comparePriceCents ?? null,
      },
    };
  });

  const { result: createdProducts } = await createProductsWorkflow(
    container
  ).run({ input: { products: productsInput } });
  logger.info(`Producten aangemaakt: ${createdProducts.length}.`);

  // --- inventory levels for the new variants ---
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
    logger.info(`Voorraadniveaus gezet voor ${itemsWithoutLevel.length} varianten (1000 elk).`);
  }

  logger.info("GradePurity catalogus-seed afgerond. ✅");
}
