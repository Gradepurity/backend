import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import {
  createOrderFulfillmentWorkflow,
  createOrderShipmentWorkflow,
} from "@medusajs/medusa/core-flows";

/**
 * Markeer een order als verzonden met track & trace. Maakt zo nodig eerst de
 * fulfillment aan en registreert daarna de shipment met trackinglabel; de
 * shipment-created-subscriber stuurt vervolgens de "onderweg"-mail met T&T.
 *   npx medusa exec ./src/scripts/ship-order.ts <display_id> <tracking_number> [tracking_url]
 */
export default async function shipOrder({ container, args }: ExecArgs) {
  const logger = container.resolve("logger");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const displayId = Number(args?.[0]);
  const trackingNumber = args?.[1];
  const trackingUrl = args?.[2] ?? "";
  if (!displayId || !trackingNumber) {
    logger.error(
      "Gebruik: medusa exec ./src/scripts/ship-order.ts <display_id> <tracking_number> [tracking_url]"
    );
    return;
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "email",
      "items.id",
      "items.detail.quantity",
      "items.title",
      "fulfillments.id",
      "fulfillments.shipped_at",
      "fulfillments.canceled_at",
    ],
    // display_id is numeriek in de DB maar het gegenereerde filter-type verwacht string
    filters: { display_id: displayId as unknown as string },
  });

  const order = (orders as any[])[0];
  if (!order) {
    logger.error(`Order #${displayId} niet gevonden`);
    return;
  }

  const items = (order.items ?? []).map((i: any) => ({
    id: i.id,
    quantity: Number(i.detail?.quantity ?? i.quantity),
  }));
  if (items.some((i: any) => !Number.isFinite(i.quantity) || i.quantity <= 0)) {
    logger.error(
      `Order #${displayId}: kon item-aantallen niet bepalen: ${JSON.stringify(items)}`
    );
    return;
  }

  let fulfillment = (order.fulfillments ?? []).find((f: any) => !f.canceled_at);
  if (fulfillment?.shipped_at) {
    logger.info(
      `Order #${displayId}: fulfillment ${fulfillment.id} is al verzonden (${fulfillment.shipped_at})`
    );
    return;
  }

  if (!fulfillment) {
    logger.info(`Order #${displayId} (${order.email}): fulfillment aanmaken…`);
    const { result } = await createOrderFulfillmentWorkflow(container).run({
      input: { order_id: order.id, items },
    });
    fulfillment = result;
  }

  logger.info(
    `Order #${displayId}: shipment registreren met T&T ${trackingNumber}…`
  );
  await createOrderShipmentWorkflow(container).run({
    input: {
      order_id: order.id,
      fulfillment_id: fulfillment.id,
      items,
      labels: [
        {
          tracking_number: trackingNumber,
          tracking_url: trackingUrl,
          label_url: "",
        },
      ],
    },
  });

  logger.info(`Order #${displayId}: verzonden gemarkeerd.`);

  // Lokale event bus verwerkt shipment.created asynchroon — even wachten
  // zodat de mail-subscriber kan draaien voordat het proces stopt.
  await new Promise((r) => setTimeout(r, 8000));
  logger.info("Klaar (subscriber-window verstreken).");
}
