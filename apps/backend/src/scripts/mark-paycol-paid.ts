import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { markPaymentCollectionAsPaid } from "@medusajs/medusa/core-flows";

/**
 * Markeer een not_paid payment-collection van een order als betaald.
 * Nodig als een order-edit de oorspronkelijke collection heeft geannuleerd
 * en een nieuwe lege heeft aangemaakt (dan werkt capture-bank-payment.ts niet).
 * De payment-captured-subscriber stuurt daarna de "betaling ontvangen"-mail.
 *   npx medusa exec ./src/scripts/mark-paycol-paid.ts <display_id>
 */
export default async function markPaycolPaid({ container, args }: ExecArgs) {
  const logger = container.resolve("logger");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const displayId = Number(args?.[0]);
  if (!displayId) {
    logger.error("Gebruik: medusa exec ./src/scripts/mark-paycol-paid.ts <display_id>");
    return;
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "email",
      "payment_collections.id",
      "payment_collections.status",
      "payment_collections.amount",
    ],
    filters: { display_id: displayId as unknown as string },
  });

  const order = (orders as any[])[0];
  if (!order) {
    logger.error(`Order #${displayId} niet gevonden`);
    return;
  }

  const notPaid = (order.payment_collections ?? []).find((pc: any) => pc.status === "not_paid");
  if (!notPaid) {
    logger.error(
      `Order #${displayId}: geen not_paid payment-collection gevonden (statussen: ${(order.payment_collections ?? [])
        .map((pc: any) => pc.status)
        .join(", ")})`
    );
    return;
  }

  logger.info(
    `Order #${displayId} (${order.email}): markeer ${notPaid.id} als betaald | €${Number(notPaid.amount).toFixed(2)}`
  );

  await markPaymentCollectionAsPaid(container).run({
    input: {
      order_id: order.id,
      payment_collection_id: notPaid.id,
      captured_by: "mark-paycol-paid-script",
    },
  });

  logger.info(`Order #${displayId}: payment-collection als betaald gemarkeerd.`);

  // Lokale event bus verwerkt payment.captured asynchroon — even wachten
  // zodat de mail-subscriber kan draaien voordat het proces stopt.
  await new Promise((r) => setTimeout(r, 8000));
  logger.info("Klaar (subscriber-window verstreken).");
}
