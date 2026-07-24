import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

/**
 * Alle gecaptureerde Wallid-betalingen op een rij (datum, order, bedrag) +
 * totaal, om af te stemmen tegen de Wallid-uitbetalingen op de Finom-rekening.
 */
export default async function wallidReconciliatie({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const { data: payments } = await query.graph({
    entity: "payment",
    fields: [
      "id",
      "amount",
      "provider_id",
      "captured_at",
      "canceled_at",
      "payment_collection.order.display_id",
      "payment_collection.order.email",
    ],
    filters: { provider_id: "pp_card_wallid" },
  });

  const captured = payments
    .filter((p) => p.captured_at && !p.canceled_at)
    .sort(
      (a, b) =>
        new Date(a.captured_at as any).getTime() -
        new Date(b.captured_at as any).getTime()
    );

  let total = 0;
  for (const p of captured) {
    const d = new Date(p.captured_at as any);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const amt = Number(p.amount);
    total += amt;
    logger.info(
      `${dateStr}  #${p.payment_collection?.order?.display_id ?? "?"}  €${amt.toFixed(2)}  ${p.payment_collection?.order?.email ?? ""}`
    );
  }
  logger.info(
    `TOTAAL ${captured.length} Wallid-betalingen gecaptured: €${total.toFixed(2)}`
  );
}
