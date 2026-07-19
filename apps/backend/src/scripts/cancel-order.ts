import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { cancelOrderWorkflow } from "@medusajs/medusa/core-flows";

/**
 * Annuleer een order (bijv. vooruitbetaling die nooit binnenkwam).
 * Weigert orders die al (deels) verzonden of betaald-gecaptured zijn.
 *   npx medusa exec ./src/scripts/cancel-order.ts <display_id>
 */
export default async function cancelOrder({ container, args }: ExecArgs) {
  const logger = container.resolve("logger");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const displayId = Number(args?.[0]);
  if (!displayId) {
    logger.error("Gebruik: medusa exec ./src/scripts/cancel-order.ts <display_id>");
    return;
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "email",
      "status",
      "fulfillments.id",
      "fulfillments.shipped_at",
      "fulfillments.canceled_at",
      "payment_collections.payments.provider_id",
      "payment_collections.payments.captured_at",
    ],
    filters: { display_id: displayId as unknown as string },
  });

  const order = (orders as any[])[0];
  if (!order) {
    logger.error(`Order #${displayId} niet gevonden`);
    return;
  }
  if (order.status === "canceled") {
    logger.info(`Order #${displayId} is al geannuleerd.`);
    return;
  }

  const shipped = (order.fulfillments ?? []).some(
    (f: any) => !f.canceled_at && f.shipped_at
  );
  if (shipped) {
    logger.error(`Order #${displayId} is al verzonden — niet annuleren via dit script.`);
    return;
  }
  const captured = (order.payment_collections ?? [])
    .flatMap((pc: any) => pc.payments ?? [])
    .some((p: any) => p.captured_at);
  if (captured) {
    logger.error(
      `Order #${displayId} heeft een gecapturede betaling — eerst refunden, niet annuleren via dit script.`
    );
    return;
  }

  logger.info(`Order #${displayId} (${order.email}) annuleren…`);
  await cancelOrderWorkflow(container).run({
    input: { order_id: order.id },
  });
  logger.info(`Order #${displayId}: geannuleerd.`);
}
