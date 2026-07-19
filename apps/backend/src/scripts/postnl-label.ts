import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import {
  createOrderFulfillmentWorkflow,
  createOrderShipmentWorkflow,
} from "@medusajs/medusa/core-flows";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  createLabel,
  postnlConfigFromEnv,
  trackingUrl,
} from "../lib/postnl";

/**
 * Genereert een PostNL-verzendlabel (PDF) + 3S-track&trace voor een order en
 * markeert de order optioneel direct als verzonden (zelfde flow als
 * ship-order.ts, incl. "onderweg"-mail via de shipment-subscriber).
 *
 *   npx medusa exec ./src/scripts/postnl-label.ts <display_id> [ship]
 *
 * Zonder "ship" wordt alleen het label gemaakt; het script print dan het
 * ship-order-commando om de order later als verzonden te markeren.
 * Label-PDF komt in apps/backend/labels/.
 */
export default async function postnlLabel({ container, args }: ExecArgs) {
  const logger = container.resolve("logger");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const displayId = Number(args?.[0]);
  const alsoShip = args?.[1] === "ship";
  if (!displayId) {
    logger.error(
      "Gebruik: medusa exec ./src/scripts/postnl-label.ts <display_id> [ship]"
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
      "shipping_address.first_name",
      "shipping_address.last_name",
      "shipping_address.company",
      "shipping_address.address_1",
      "shipping_address.address_2",
      "shipping_address.postal_code",
      "shipping_address.city",
      "shipping_address.country_code",
      "shipping_address.phone",
      "fulfillments.id",
      "fulfillments.shipped_at",
      "fulfillments.canceled_at",
    ],
    filters: { display_id: displayId as unknown as string },
  });

  const order = (orders as any[])[0];
  if (!order) {
    logger.error(`Order #${displayId} niet gevonden`);
    return;
  }
  const addr = order.shipping_address;
  if (!addr?.address_1 || !addr?.postal_code || !addr?.city) {
    logger.error(
      `Order #${displayId}: verzendadres incompleet: ${JSON.stringify(addr)}`
    );
    return;
  }
  const country = (addr.country_code ?? "nl").toUpperCase();

  logger.info(
    `Order #${displayId} (${order.email}): PostNL-label maken voor ${addr.first_name} ${addr.last_name}, ${addr.address_1}, ${addr.postal_code} ${addr.city} (${country})…`
  );

  const cfg = postnlConfigFromEnv();
  const streetHouseNr = [addr.address_1, addr.address_2]
    .filter(Boolean)
    .join(" ");
  const { barcode, labelPdfBase64 } = await createLabel(
    cfg,
    {
      firstName: addr.first_name ?? "",
      lastName: addr.last_name ?? "",
      company: addr.company ?? "",
      streetHouseNr,
      zip: addr.postal_code,
      city: addr.city,
      countryCode: country,
      email: order.email ?? "",
      phone: addr.phone ?? "",
    },
    { reference: `GP-${displayId}` }
  );

  const labelsDir = join(process.cwd(), "labels");
  mkdirSync(labelsDir, { recursive: true });
  const labelPath = join(labelsDir, `order-${displayId}-${barcode}.pdf`);
  writeFileSync(labelPath, Buffer.from(labelPdfBase64, "base64"));

  const ttUrl = trackingUrl(barcode, country, addr.postal_code);
  logger.info(`Order #${displayId}: barcode ${barcode}`);
  logger.info(`Label: ${labelPath}`);
  logger.info(`Track & trace: ${ttUrl}`);

  if (!alsoShip) {
    logger.info(
      `Nog niet als verzonden gemarkeerd. Doe dat bij het wegbrengen met:\n` +
        `  npx medusa exec ./src/scripts/ship-order.ts ${displayId} ${barcode} "${ttUrl}"\n` +
        `of draai dit script opnieuw met "ship" erachter.`
    );
    return;
  }

  const items = (order.items ?? []).map((i: any) => ({
    id: i.id,
    quantity: Number(i.detail?.quantity ?? i.quantity),
  }));
  let fulfillment = (order.fulfillments ?? []).find((f: any) => !f.canceled_at);
  if (fulfillment?.shipped_at) {
    logger.info(
      `Order #${displayId}: al verzonden (${fulfillment.shipped_at}); alleen label opnieuw gegenereerd.`
    );
    return;
  }
  if (!fulfillment) {
    const { result } = await createOrderFulfillmentWorkflow(container).run({
      input: { order_id: order.id, items },
    });
    fulfillment = result;
  }
  await createOrderShipmentWorkflow(container).run({
    input: {
      order_id: order.id,
      fulfillment_id: fulfillment.id,
      items,
      labels: [
        { tracking_number: barcode, tracking_url: ttUrl, label_url: "" },
      ],
    },
  });
  logger.info(`Order #${displayId}: verzonden gemarkeerd met T&T ${barcode}.`);
  await new Promise((r) => setTimeout(r, 8000));
  logger.info("Klaar (subscriber-window verstreken).");
}
