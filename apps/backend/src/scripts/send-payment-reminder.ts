import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { buildOrderEmailData } from "../lib/order-email";

/**
 * Stuur een betaalherinnering (payment-reminder-template met bankgegevens en
 * GP-kenmerk) voor een vooruitbetaling-order waarvan de betaling uitblijft.
 * Weigert orders die geannuleerd of al betaald (captured) zijn.
 *   npx medusa exec ./src/scripts/send-payment-reminder.ts <display_id>
 */
export default async function sendPaymentReminder({ container, args }: ExecArgs) {
  const logger = container.resolve("logger");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const displayId = Number(args?.[0]);
  if (!displayId) {
    logger.error("Gebruik: medusa exec ./src/scripts/send-payment-reminder.ts <display_id>");
    return;
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "status",
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
    logger.error(`Order #${displayId} is geannuleerd — geen herinnering versturen.`);
    return;
  }
  const captured = (order.payment_collections ?? [])
    .flatMap((pc: any) => pc.payments ?? [])
    .some((p: any) => p.captured_at);
  if (captured) {
    logger.error(`Order #${displayId} is al betaald — geen herinnering nodig.`);
    return;
  }

  const payload = await buildOrderEmailData(container, order.id);
  if (!payload) {
    logger.error(`[reminder] geen maildata voor order #${displayId}`);
    return;
  }
  // "bank" = klassieke vooruitbetaling; "bankpay" = afgebroken BANKpay-poging —
  // beide kunnen alsnog handmatig overmaken met het GP-kenmerk uit deze mail.
  if (payload.data.payment_method !== "bank" && payload.data.payment_method !== "bankpay") {
    logger.error(
      `Order #${displayId} is geen vooruitbetaling (${payload.data.payment_method}) — reminder is daarop gericht.`
    );
    return;
  }

  const notifications = container.resolve(Modules.NOTIFICATION);
  const result = await notifications.createNotifications({
    to: payload.email,
    channel: "email",
    template: "payment-reminder",
    data: payload.data as unknown as Record<string, unknown>,
  });
  logger.info(
    `[reminder] betaalherinnering -> ${payload.email} voor order #${displayId}: ${(result as any).status ?? "ok"}`
  );
}
