import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

/**
 * Read-only: toont carts/orders van vandaag mét regelprijzen om een gemeld
 * prijsverschil (storefront €78 vs bank-bevestiging €106) te herleiden.
 *   npx medusa exec ./src/scripts/diagnose-prijsverschil.ts
 */
export default async function diagnosePrijsverschil({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Amsterdam", dateStyle: "short" });
  const today = fmt.format(new Date());
  const isRecent = (d: any) => {
    if (!d) return false;
    const day = fmt.format(new Date(d));
    return day === today;
  };

  const { data: carts } = await query.graph({
    entity: "cart",
    fields: [
      "id",
      "email",
      "created_at",
      "updated_at",
      "completed_at",
      "shipping_address.country_code",
      "items.title",
      "items.product_title",
      "items.variant_title",
      "items.quantity",
      "items.unit_price",
      "shipping_methods.name",
      "shipping_methods.amount",
    ],
  });

  const recent = (carts as any[]).filter((c) => isRecent(c.updated_at) || isRecent(c.created_at));
  logger.info(`\n===== CARTS ACTIEF VANDAAG (${today}): ${recent.length} =====`);
  for (const c of recent.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))) {
    const items = (c.items ?? []) as any[];
    const itemsTotal = items.reduce((s, i) => s + Number(i.unit_price) * Number(i.quantity), 0);
    const ship = (c.shipping_methods ?? []) as any[];
    const shipTotal = ship.reduce((s, m) => s + Number(m.amount ?? 0), 0);
    logger.info(
      `\nCART ${c.id} | ${c.email ?? "(geen email)"} | land=${c.shipping_address?.country_code ?? "-"} | ` +
        `laatst actief ${c.updated_at} | order=${c.completed_at ? "JA" : "nee"}`
    );
    for (const i of items) {
      logger.info(
        `   ${i.quantity}× ${i.product_title ?? i.title} [${i.variant_title ?? "-"}] à €${Number(i.unit_price).toFixed(2)} = €${(Number(i.unit_price) * Number(i.quantity)).toFixed(2)}`
      );
    }
    logger.info(`   verzending: €${shipTotal.toFixed(2)} | items: €${itemsTotal.toFixed(2)} | SOM: €${(itemsTotal + shipTotal).toFixed(2)}`);
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "email",
      "created_at",
      "total",
      "item_total",
      "shipping_total",
      "shipping_address.country_code",
      "items.product_title",
      "items.variant_title",
      "items.quantity",
      "items.unit_price",
    ],
  });
  const recentOrders = (orders as any[]).filter((o) => isRecent(o.created_at));
  logger.info(`\n===== ORDERS VANDAAG: ${recentOrders.length} =====`);
  for (const o of recentOrders) {
    logger.info(
      `\nORDER #${o.display_id} | ${o.email} | land=${o.shipping_address?.country_code ?? "-"} | ${o.created_at}` +
        ` | items €${Number(o.item_total).toFixed(2)} + verzend €${Number(o.shipping_total).toFixed(2)} = TOTAAL €${Number(o.total).toFixed(2)}`
    );
    for (const i of (o.items ?? []) as any[]) {
      logger.info(`   ${i.quantity}× ${i.product_title} [${i.variant_title ?? "-"}] à €${Number(i.unit_price).toFixed(2)}`);
    }
  }
  logger.info("===== EIND =====\n");
}
