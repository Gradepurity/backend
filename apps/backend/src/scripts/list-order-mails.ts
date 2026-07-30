import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";

/**
 * Read-only: alle verstuurde notificaties (Resend-mails) voor één order,
 * gematcht op data.display_id. Toont template, ontvanger en tijdstip —
 * om te zien of bv. de payment-captured-mail echt is verstuurd.
 *   npx medusa exec ./src/scripts/list-order-mails.ts <display_id>
 */
export default async function listOrderMails({ container, args }: ExecArgs) {
  const logger = container.resolve("logger");
  const notifications: any = container.resolve(Modules.NOTIFICATION);
  const displayId = Number(args?.[0]);
  if (!displayId) {
    logger.error("Gebruik: npx medusa exec ./src/scripts/list-order-mails.ts <display_id>");
    return;
  }

  const rows = await notifications.listNotifications(
    {},
    { select: ["to", "template", "channel", "created_at", "data", "status"], take: 1000, order: { created_at: "DESC" } }
  );

  const hits = rows.filter((n: any) => {
    const d = n.data ?? {};
    return Number(d.display_id) === displayId || String(d.order_display_id ?? "") === String(displayId);
  });

  logger.info(`\n===== NOTIFICATIES VOOR #${displayId}: ${hits.length} =====`);
  for (const n of hits) {
    logger.info(
      `${new Date(n.created_at).toISOString()} | template=${n.template} | to=${n.to} | status=${n.status ?? "?"}`
    );
  }
  if (!hits.length) {
    logger.info("(geen — check of de subscriber gevuurd heeft)");
  }
  logger.info(`===== EIND =====\n`);
}
