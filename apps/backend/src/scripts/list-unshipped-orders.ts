import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

/**
 * Read-only: toont recente orders met fulfillment/verzendstatus en adres,
 * om track & trace-codes aan de juiste order te kunnen koppelen.
 *   npx medusa exec ./src/scripts/list-unshipped-orders.ts
 */
export default async function listUnshippedOrders({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "email",
      "created_at",
      "status",
      "shipping_address.first_name",
      "shipping_address.last_name",
      "shipping_address.city",
      "shipping_address.postal_code",
      "shipping_address.country_code",
      "fulfillments.id",
      "fulfillments.shipped_at",
      "fulfillments.canceled_at",
      "fulfillments.labels.tracking_number",
    ],
  });

  const sorted = (orders as any[])
    .filter((o) => o.status !== "canceled")
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  logger.info(`\n===== LAATSTE 15 ORDERS (nieuwste eerst) =====`);
  for (const o of sorted.slice(0, 15)) {
    const adr = o.shipping_address;
    const wie = adr
      ? `${adr.first_name ?? ""} ${adr.last_name ?? ""} | ${adr.postal_code ?? ""} ${adr.city ?? ""} ${adr.country_code ?? ""}`
      : "(geen adres)";
    const fulfs = (o.fulfillments ?? []).filter((f: any) => !f.canceled_at);
    const ship = fulfs.length
      ? fulfs
          .map(
            (f: any) =>
              `${f.shipped_at ? "VERZONDEN " + f.shipped_at : "fulfillment, niet verzonden"}${
                (f.labels ?? []).length
                  ? " T&T:" + f.labels.map((l: any) => l.tracking_number).join(",")
                  : ""
              }`
          )
          .join(" / ")
      : "GEEN fulfillment";
    logger.info(`#${o.display_id} | ${o.created_at} | ${o.email} | status=${o.status} | ${wie} | ${ship}`);
  }
  logger.info("===== EIND =====\n");
}
