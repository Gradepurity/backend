import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

/**
 * Print de metadata van een order (cadeaus/staffel zitten daar in).
 *   npx medusa exec ./src/scripts/print-order-meta.ts <display_id>
 */
export default async function printOrderMeta({ container, args }: ExecArgs) {
  const logger = container.resolve("logger");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const displayId = Number(args?.[0]);
  if (!displayId) {
    logger.error("Gebruik: medusa exec ./src/scripts/print-order-meta.ts <display_id>");
    return;
  }
  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["id", "display_id", "metadata"],
    filters: { display_id: displayId as unknown as string },
  });
  const order = (orders as any[])[0];
  if (!order) {
    logger.error(`Order #${displayId} niet gevonden`);
    return;
  }
  logger.info(`Order #${displayId} metadata: ${JSON.stringify(order.metadata, null, 2)}`);
}
