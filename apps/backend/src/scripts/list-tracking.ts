import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

/**
 * Print alle verzonden orders met hun track & trace-gegevens als JSON-regels
 * (voor de live PostNL-statuscheck).
 *
 *   npx medusa exec ./src/scripts/list-tracking.ts
 */
export default async function listTracking({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "display_id",
      "status",
      "email",
      "shipping_address.postal_code",
      "shipping_address.country_code",
      "shipping_address.last_name",
      "fulfillments.shipped_at",
      "fulfillments.canceled_at",
      "fulfillments.labels.tracking_number",
      "fulfillments.labels.tracking_url",
    ],
  });

  const rows: any[] = [];
  for (const o of orders as any[]) {
    if (o.status === "canceled" || o.status === "draft") continue;
    for (const f of o.fulfillments ?? []) {
      if (f.canceled_at) continue;
      for (const l of f.labels ?? []) {
        if (!l.tracking_number) continue;
        rows.push({
          order: Number(o.display_id),
          email: o.email,
          naam: o.shipping_address?.last_name ?? "",
          barcode: l.tracking_number,
          zip: String(o.shipping_address?.postal_code ?? "").replace(/\s+/g, "").toUpperCase(),
          land: String(o.shipping_address?.country_code ?? "nl").toUpperCase(),
          verzonden: f.shipped_at ? new Date(f.shipped_at).toISOString().slice(0, 10) : null,
        });
      }
    }
  }
  rows.sort((a, b) => a.order - b.order);
  logger.info(`TRACKING_JSON_START`);
  for (const r of rows) logger.info(JSON.stringify(r));
  logger.info(`TRACKING_JSON_END (${rows.length} zendingen)`);
}
