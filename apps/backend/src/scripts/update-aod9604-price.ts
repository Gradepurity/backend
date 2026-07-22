import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { updateProductVariantsWorkflow } from "@medusajs/medusa/core-flows";

/**
 * One-off: brengt de EUR-prijs van de aod9604-variant naar €44,95.
 * Non-destructief — werkt alleen het price set van de bestaande variant bij.
 */
const TARGET_SLUG = "aod9604";
const NEW_AMOUNT = 44.95;

export default async function updateAod9604Price({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const { data: products } = await query.graph({
    entity: "product",
    fields: ["id", "handle", "variants.id", "variants.title"],
    filters: { handle: TARGET_SLUG },
  });
  const product = products[0];
  if (!product) throw new Error(`Product ${TARGET_SLUG} niet gevonden.`);

  await updateProductVariantsWorkflow(container).run({
    input: {
      product_variants: product.variants.map((v: { id: string }) => ({
        id: v.id,
        prices: [{ currency_code: "eur", amount: NEW_AMOUNT }],
      })),
    },
  });

  logger.info(
    `Prijs bijgewerkt naar €${NEW_AMOUNT} voor ${product.variants.length} variant(en) van ${TARGET_SLUG}. ✅`
  );
}
