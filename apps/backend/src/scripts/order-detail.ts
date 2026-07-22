import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { eur } from "./boekhouding-config";

/**
 * Detail van één order op display_id.
 * Draaien: npx medusa exec ./src/scripts/order-detail.ts <display_id>
 */
export default async function orderDetail({
  container,
  args,
}: {
  container: MedusaContainer;
  args?: string[];
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const displayId = Number((args ?? [])[0]);
  if (!displayId) {
    logger.error("Gebruik: npx medusa exec ./src/scripts/order-detail.ts <display_id>");
    return;
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "status",
      "created_at",
      "email",
      "summary.*",
      "items.title",
      "items.variant_title",
      "items.quantity",
      "items.unit_price",
      "shipping_address.first_name",
      "shipping_address.last_name",
      "shipping_address.address_1",
      "shipping_address.postal_code",
      "shipping_address.city",
      "shipping_address.country_code",
      "fulfillments.id",
      "fulfillments.shipped_at",
      "payment_collections.payments.provider_id",
      "payment_collections.payments.captured_at",
    ],
    filters: { display_id: displayId } as any,
  });

  const o = (orders as any[])[0];
  if (!o) {
    logger.error(`Order #${displayId} niet gevonden.`);
    return;
  }

  const a = o.shipping_address ?? {};
  logger.info(`\n===== ORDER #${o.display_id} =====`);
  logger.info(`Datum:    ${new Date(o.created_at).toLocaleString("nl-NL")}`);
  logger.info(`Status:   ${o.status}`);
  logger.info(`Klant:    ${a.first_name ?? ""} ${a.last_name ?? ""} <${o.email}>`);
  logger.info(`Adres:    ${a.address_1 ?? ""}, ${a.postal_code ?? ""} ${a.city ?? ""} (${String(a.country_code ?? "").toUpperCase()})`);
  logger.info(`Items:`);
  for (const it of o.items ?? []) {
    logger.info(`  ${it.quantity}x ${it.title}${it.variant_title ? ` — ${it.variant_title}` : ""}  @ ${eur(Number(it.unit_price ?? 0))}`);
  }
  logger.info(`Totaal:   ${eur(Number(o.summary?.current_order_total ?? 0))}`);
  for (const pc of o.payment_collections ?? []) {
    for (const p of pc.payments ?? []) {
      logger.info(`Betaling: ${String(p.provider_id ?? "").replace(/^pp_/, "")} — captured: ${p.captured_at ? new Date(p.captured_at).toLocaleString("nl-NL") : "nee"}`);
    }
  }
  const verzonden = (o.fulfillments ?? []).some((f: any) => f.shipped_at);
  logger.info(`Verzonden: ${verzonden ? "ja" : "nee"}`);
  logger.info(`===== EIND =====\n`);
}
