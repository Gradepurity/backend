import { ExecArgs } from "@medusajs/framework/types";
import {
  ContainerRegistrationKeys,
  Modules,
  PaymentActions,
} from "@medusajs/framework/utils";
import { processPaymentWorkflow } from "@medusajs/medusa/core-flows";

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
}
