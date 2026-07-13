import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { buildOrderEmailData } from "../lib/order-email";

/**
 * Verstuur de order-mails (klant + admin) alsnog voor één order — zelfde pad
 * als de order-placed-subscriber. Voor orders waarvan de mails faalden.
 *   npx medusa exec ./src/scripts/resend-order-mails.ts <order_id>
 */
export default async function resendOrderMails({ container, args }: ExecArgs) {
  const logger = container.resolve("logger");
  const orderId = args?.[0];
  if (!orderId?.startsWith("order_")) {
    logger.error("Gebruik: medusa exec ./src/scripts/resend-order-mails.ts <order_id>");
    return;
  }

  const payload = await buildOrderEmailData(container, orderId);
  if (!payload) {
    logger.error(`[resend-mails] geen maildata voor ${orderId}`);
    return;
  }

  const template =
    payload.data.payment_method === "wallid" ? "payment-captured" : "order-placed";
  const notifications = container.resolve(Modules.NOTIFICATION);

  const klant = await notifications.createNotifications({
    to: payload.email,
    channel: "email",
    template,
    data: payload.data as unknown as Record<string, unknown>,
  });
  logger.info(`[resend-mails] klant-mail (${template}) -> ${payload.email}: ${(klant as any).status ?? "ok"}`);

  const adminEmail = process.env.ADMIN_ORDER_EMAIL || "info@gradepurity.com";
  const admin = await notifications.createNotifications({
    to: adminEmail,
    channel: "email",
    template: "admin-new-order",
    data: {
      ...payload.data,
      customer_email: payload.email,
    } as unknown as Record<string, unknown>,
  });
  logger.info(`[resend-mails] admin-mail -> ${adminEmail}: ${(admin as any).status ?? "ok"}`);
}
