import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

/**
 * Read-only: alle orders van vandaag (Europe/Amsterdam) met totaal en betaalstatus.
 *   npx medusa exec ./src/scripts/orders-vandaag.ts
 */
export default async function ordersVandaag({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "display_id",
      "status",
      "created_at",
      "email",
      "total",
      "currency_code",
      "shipping_address.country_code",
      "items.title",
      "items.variant_title",
      "items.quantity",
      "payment_collections.payments.provider_id",
      "payment_collections.payments.captured_at",
    ],
    pagination: { take: 1000, skip: 0 } as any,
  });

  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Amsterdam", dateStyle: "short" });
  const today = fmt.format(new Date());
  const rows = (orders as any[])
    .filter((o) => fmt.format(new Date(o.created_at)) === today)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

  logger.info(`\n===== ORDERS VANDAAG (${today}): ${rows.length} =====`);
  for (const o of rows) {
    const tijd = new Date(o.created_at).toLocaleTimeString("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit" });
    const pays = (o.payment_collections ?? [])
      .flatMap((pc: any) => pc.payments ?? [])
      .map((p: any) => `${String(p.provider_id).replace(/^pp_/, "")}${p.captured_at ? " BETAALD" : " open"}`)
      .join(", ");
    logger.info(
      `#${o.display_id} | ${tijd} | ${o.email} | ${String(o.shipping_address?.country_code ?? "-").toUpperCase()} | ` +
        `€${Number(o.total).toFixed(2)} | status=${o.status} | ${pays || "geen betaling"}`
    );
    for (const it of o.items ?? []) {
      logger.info(`    ${it.quantity}x ${it.title}${it.variant_title ? ` — ${it.variant_title}` : ""}`);
    }
  }
  logger.info(`===== EIND =====\n`);
}
