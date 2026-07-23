import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { deleteProductsWorkflow } from "@medusajs/medusa/core-flows";

/**
 * Verwijdert het tijdelijke €1-testproduct (handle 'test-product') volledig uit
 * de live catalogus. Idempotent: doet niets als het al weg is.
 *   npx medusa exec ./src/scripts/delete-test-product.ts
 */
const TARGET_SLUG = "test-product";

export default async function deleteTestProduct({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const { data: products } = await query.graph({
    entity: "product",
    fields: ["id", "handle"],
    filters: { handle: [TARGET_SLUG] },
  });

  if (!products.length) {
    logger.info(`'${TARGET_SLUG}' bestaat niet (meer) — niets te doen.`);
    return;
  }

  await deleteProductsWorkflow(container).run({
    input: { ids: products.map((p) => p.id) },
  });
  logger.info(`Verwijderd: ${TARGET_SLUG} (${products.length}). ✅`);
}
