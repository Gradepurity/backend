import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { capturePaymentWorkflow } from "@medusajs/medusa/core-flows";

/**
 * Markeer een bankoverschrijving als ontvangen (capture) voor één order.
 * De payment-captured-subscriber stuurt daarna de "betaling ontvangen"-mail.
 *   npx medusa exec ./src/scripts/capture-bank-payment.ts <display_id>
 */
export default async function captureBankPayment({ container, args }: ExecArgs) {
  const logger = container.resolve("logger");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const displayId = Number(args?.[0]);
  if (!displayId) {
    logger.error("Gebruik: medusa exec ./src/scripts/capture-bank-payment.ts <display_id>");
    return;
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "email",
      "payment_collections.status",
      "payment_collections.payments.id",
      "payment_collections.payments.provider_id",
      "payment_collections.payments.amount",
      "payment_collections.payments.captured_at",
    ],
    filters: { display_id: displayId },
  });

  const order = (orders as any[])[0];
  if (!order) {
    logger.error(`Order #${displayId} niet gevonden`);
    return;
  }

  const payment = order.payment_collections?.flatMap((pc: any) => pc.payments ?? [])[0];
  if (!payment) {
    logger.error(`Order #${displayId}: geen payment gevonden`);
    return;
  }
  if (payment.captured_at) {
    logger.info(`Order #${displayId}: payment ${payment.id} is al gecaptured (${payment.captured_at})`);
    return;
  }

  logger.info(
    `Order #${displayId} (${order.email}): capture payment ${payment.id} | ${payment.provider_id} | €${Number(payment.amount).toFixed(2)}`
  );

  await capturePaymentWorkflow(container).run({
    input: { payment_id: payment.id },
  });

  logger.info(`Order #${displayId}: betaling gecaptured.`);

  // Lokale event bus verwerkt payment.captured asynchroon — even wachten
  // zodat de mail-subscriber kan draaien voordat het proces stopt.
  await new Promise((r) => setTimeout(r, 8000));
  logger.info("Klaar (subscriber-window verstreken).");
}
