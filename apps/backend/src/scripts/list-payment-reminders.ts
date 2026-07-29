import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";

/**
 * Read-only: toont alle verstuurde betaalherinneringen (template payment-reminder)
 * met datum en ontvanger, om te zien welke openstaande orders er al één kregen.
 *   npx medusa exec ./src/scripts/list-payment-reminders.ts
 */
export default async function listPaymentReminders({ container }: ExecArgs) {
  const logger = container.resolve("logger");
  const notifications: any = container.resolve(Modules.NOTIFICATION);

  const rows = await notifications.listNotifications(
    { template: "payment-reminder" },
    { select: ["to", "template", "created_at", "data"], take: 200 }
  );

  logger.info(`\n===== VERSTUURDE BETAALHERINNERINGEN (${rows.length}) =====`);
  for (const n of rows) {
    const displayId = (n.data as any)?.display_id ?? "?";
    logger.info(`#${displayId} | ${n.to} | ${new Date(n.created_at).toISOString()}`);
  }
  logger.info("===== EIND =====\n");
}
