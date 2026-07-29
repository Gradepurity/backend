import { ExecArgs } from "@medusajs/framework/types";
import {
  ContainerRegistrationKeys,
  Modules,
  PaymentActions,
} from "@medusajs/framework/utils";
import { processPaymentWorkflow } from "@medusajs/medusa/core-flows";
import { buildOrderEmailData } from "../lib/order-email";

/**
 * Rond een BANKpay+-sessie handmatig af als BETAALD, voor betalingen die
 * buiten hun tracking om binnenkwamen (bv. de QR-Code-optie op hun betaal-
 * pagina = kale SEPA-overboeking die BANKpay+ niet kan zien). ALLEEN draaien
 * nadat het geld aantoonbaar op de Finom-rekening staat (kenmerk checken!).
 *   npx medusa exec ./src/scripts/complete-bankpay-session.ts <payses_...>
 */
export default async function completeBankpaySession({ container, args }: ExecArgs) {
  const logger = container.resolve("logger");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const sessionId = String(args?.[0] ?? "");
  if (!sessionId.startsWith("payses_")) {
    logger.error("Gebruik: medusa exec ./src/scripts/complete-bankpay-session.ts <payses_...>");
    return;
  }

  const { data: sessions } = await query.graph({
    entity: "payment_session",
    fields: [
      "id",
      "status",
      "amount",
      "currency_code",
      "data",
      "payment_collection.cart.id",
      "payment_collection.cart.completed_at",
    ],
    filters: { id: sessionId, provider_id: "pp_sepa_bankpay" },
  });
  const session = (sessions as any[])?.[0];
  if (!session) {
    logger.error(`Sessie ${sessionId} niet gevonden (of geen bankpay-sessie).`);
    return;
  }
  if (session.payment_collection?.cart?.completed_at) {
    logger.info(`Cart van ${sessionId} is al afgerond — niets te doen.`);
    return;
  }

  // manual_paid in de sessie-data: de provider's authorizePayment accepteert
  // die vlag als bewijs (zie bankpay/service.ts) — BANKpay+ zelf blijft
  // immers op "created" staan bij een QR-betaling.
  const paymentModule = container.resolve(Modules.PAYMENT);
  await paymentModule.updatePaymentSession({
    id: session.id,
    currency_code: session.currency_code,
    amount: session.amount,
    data: { ...(session.data ?? {}), manual_paid: true },
  });
  logger.info(`manual_paid gezet op ${sessionId}.`);

  await processPaymentWorkflow(container).run({
    input: {
      action: PaymentActions.SUCCESSFUL,
      data: { session_id: session.id, amount: session.amount },
    },
  });
  logger.info(
    `Sessie ${sessionId} (€${session.amount}, checkout ${(session.data as any)?.checkout_uuid ?? "?"}) als betaald verwerkt — order aangemaakt. ✅`
  );

  // De order.placed-subscriber draait in dít (lokale) proces en wordt normaal
  // afgekapt zodra het script eindigt (zie #1948: mails bleven uit). Daarom:
  // subscribers even laten uitdraaien, daarna checken wat er daadwerkelijk in
  // de notificatietabel staat en alléén het ontbrekende alsnog versturen.
  await new Promise((r) => setTimeout(r, 12000));

  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["id", "display_id", "created_at"],
    filters: {},
  });
  const order = (orders as any[])
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  if (!order) {
    logger.error("Order niet teruggevonden — mails handmatig via resend-order-mails.ts.");
    return;
  }
  const payload = await buildOrderEmailData(container, order.id);
  if (!payload) {
    logger.error(`Geen maildata voor order #${order.display_id} — resend-order-mails.ts draaien.`);
    return;
  }

  const adminEmail = process.env.ADMIN_ORDER_EMAIL || "info@gradepurity.com";
  const cutoff = Date.now() - 5 * 60 * 1000;
  const { data: notifs } = await query.graph({
    entity: "notification",
    fields: ["to", "template", "created_at"],
    filters: {},
  });
  const recent = (notifs as any[]).filter(
    (n) => new Date(n.created_at).getTime() >= cutoff
  );
  const hasKlant = recent.some(
    (n) => n.to === payload.email && n.template === "payment-captured"
  );
  const hasAdmin = recent.some(
    (n) => n.to === adminEmail && n.template === "admin-new-order"
  );

  const notifications = container.resolve(Modules.NOTIFICATION);
  if (!hasKlant) {
    await notifications.createNotifications({
      to: payload.email,
      channel: "email",
      template: "payment-captured",
      data: payload.data as unknown as Record<string, unknown>,
    });
    logger.info(`Klant-mail (payment-captured) alsnog verstuurd -> ${payload.email}.`);
  }
  if (!hasAdmin) {
    await notifications.createNotifications({
      to: adminEmail,
      channel: "email",
      template: "admin-new-order",
      data: {
        ...payload.data,
        customer_email: payload.email,
      } as unknown as Record<string, unknown>,
    });
    logger.info(`Admin-mail alsnog verstuurd -> ${adminEmail}.`);
  }
  logger.info(
    `Order #${order.display_id}: mails compleet (klant ${hasKlant ? "via subscriber" : "via script"}, admin ${hasAdmin ? "via subscriber" : "via script"}). ✅`
  );
}
