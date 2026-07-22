import { MedusaContainer } from "@medusajs/framework";
import {
  ContainerRegistrationKeys,
  ProductStatus,
} from "@medusajs/framework/utils";
import {
  createInventoryLevelsWorkflow,
  createProductsWorkflow,
} from "@medusajs/medusa/core-flows";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Surgical add of a single GradePurity product (thymosin-alpha-1) to the live
 * catalog WITHOUT the destructive delete/rebuild the full seed does — the full
 * seed is blocked when any existing inventory item has open reservations.
 * Idempotent: skips if the handle already exists.
 */
const TARGET_SLUG = "thymosin-alpha-1";

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

type CatalogVariant = { id: string; name: string; priceCents: number };
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
  peptide?: Record<string, unknown>;
  bundle?: { name: string; vialMg: number }[];
};

export default async function addThymosinAlpha1({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const catalog = JSON.parse(
    readFileSync(join(process.cwd(), "src/scripts/catalog.json"), "utf-8")
  ) as { products: CatalogProduct[] };
  const p = catalog.products.find((x) => x.slug === TARGET_SLUG);
  if (!p) throw new Error(`Product ${TARGET_SLUG} niet in catalog.json.`);

  // already present? -> idempotent skip
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
  const categoryId = cats.find((c) => c.handle === p.hub)?.id;

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

  const productInput = {
    title: p.name,
    handle: p.slug,
    description: p.longDescription || p.shortDescription,
    status: ProductStatus.PUBLISHED,
    category_ids: categoryId ? [categoryId] : [],
    shipping_profile_id: shippingProfile.id,
    options: [{ title: "Formaat", values: variants.map((v) => v.name) }],
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

  const { result: created } = await createProductsWorkflow(container).run({
    input: { products: [productInput] },
  });
  logger.info(`Product aangemaakt: ${created.map((c) => c.handle).join(", ")}.`);

  // inventory levels for the new variants only
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

  logger.info("Thymosin Alpha-1 toegevoegd aan live catalogus. ✅");
}
