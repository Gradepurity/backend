import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { createOrderFulfillmentWorkflow } from "@medusajs/medusa/core-flows";

/**
 * Maak alleen de fulfillment aan (boekt voorraad af en heft reserveringen op),
 * zonder shipment/track & trace — die volgt later via ship-order.ts, dat een
 * bestaande fulfillment gewoon hergebruikt.
 *   npx medusa exec ./src/scripts/fulfill-order.ts <display_id>
 */
export default async function fulfillOrder({ container, args }: ExecArgs) {
  const logger = container.resolve("logger");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const displayId = Number(args?.[0]);
  if (!displayId) {
    logger.error("Gebruik: medusa exec ./src/scripts/fulfill-order.ts <display_id>");
    return;
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "email",
      "items.id",
      "items.title",
      "items.detail.quantity",
      "fulfillments.id",
      "fulfillments.canceled_at",
    ],
    filters: { display_id: displayId as unknown as string },
  });
  const order = (orders as any[])[0];
  if (!order) {
    logger.error(`Order #${displayId} niet gevonden`);
    return;
  }
  if ((order.fulfillments ?? []).some((f: any) => !f.canceled_at)) {
    logger.info(`Order #${displayId} heeft al een actieve fulfillment — niets te doen.`);
    return;
  }

  const items = (order.items ?? []).map((i: any) => ({
    id: i.id,
    quantity: Number(i.detail?.quantity ?? i.quantity),
  }));
  if (items.some((i: any) => !Number.isFinite(i.quantity) || i.quantity <= 0)) {
    logger.error(`Order #${displayId}: kon item-aantallen niet bepalen: ${JSON.stringify(items)}`);
    return;
  }

  await createOrderFulfillmentWorkflow(container).run({
    input: { order_id: order.id, items },
  });
  logger.info(`Order #${displayId} (${order.email}): fulfillment aangemaakt, voorraad afgeboekt.`);
}
