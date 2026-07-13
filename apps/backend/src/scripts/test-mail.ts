import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";

/**
 * Stuur een test-notificatie door het volledige notification-pad (module ->
 * provider-registratie -> Resend). Reproduceert "Could not find a notification
 * provider for channel: email" als de registratie stuk is.
 *   RESEND_API_KEY=... RESEND_FROM=... npx medusa exec ./src/scripts/test-mail.ts
 */
export default async function testMail({ container }: ExecArgs) {
  const logger = container.resolve("logger");
  const to = process.env.TEST_MAIL_TO || "info@webreaktor.nl";
  logger.info(
    `[test-mail] resendEnabled-omgeving: api_key=${!!process.env.RESEND_API_KEY} from=${!!process.env.RESEND_FROM}`
  );
  const notifications = container.resolve(Modules.NOTIFICATION);
  const result = await notifications.createNotifications({
    to,
    channel: "email",
    template: "admin-new-order",
    data: {
      display_id: "TEST",
      currency_code: "eur",
      items: [{ title: "Testregel", quantity: 1, total: 1 }],
      totals: { total: 1 },
      payment_method: "wallid",
      customer_email: "test@voorbeeld.nl",
    },
  });
  logger.info(`[test-mail] resultaat: ${JSON.stringify(result)}`);
}
