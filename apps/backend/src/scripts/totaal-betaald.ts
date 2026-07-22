import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { SKIP_DISPLAY_IDS, eur } from "./boekhouding-config";

/**
 * Totaal daadwerkelijk betaald: som van alle captured betalingen over alle
 * orders (testorders uit SKIP_DISPLAY_IDS uitgesloten).
 *
 * Draaien (vanuit apps/backend):
 *   npx medusa exec ./src/scripts/totaal-betaald.ts
 */
export default async function totaalBetaald({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "status",
      "created_at",
      "email",
      "summary.*",
      "payment_collections.payments.id",
      "payment_collections.payments.amount",
      "payment_collections.payments.provider_id",
      "payment_collections.payments.captured_at",
      "payment_collections.payments.canceled_at",
      "payment_collections.payments.captures.amount",
      "payment_collections.payments.refunds.amount",
    ],
  });

  const geldig = (orders as any[])
    .filter((o) => o.status !== "canceled" && o.status !== "draft")
    .filter((o) => !SKIP_DISPLAY_IDS.includes(Number(o.display_id)));

  let totaal = 0;
  let totaalRefund = 0;
  const betaaldeOrders: { display_id: number; datum: string; email: string; bedrag: number; provider: string }[] = [];
  const perProvider = new Map<string, { aantal: number; bedrag: number }>();

  for (const o of geldig) {
    let orderBedrag = 0;
    let provider = "";
    for (const pc of o.payment_collections ?? []) {
      for (const p of pc.payments ?? []) {
        if (p.canceled_at) continue;
        const captured = (p.captures ?? []).reduce(
          (s: number, c: any) => s + Number(c.amount ?? 0),
          0
        );
        const refunded = (p.refunds ?? []).reduce(
          (s: number, r: any) => s + Number(r.amount ?? 0),
          0
        );
        if (captured > 0) {
          orderBedrag += captured;
          totaalRefund += refunded;
          provider = String(p.provider_id ?? "");
        }
      }
    }
    if (orderBedrag > 0) {
      totaal += orderBedrag;
      betaaldeOrders.push({
        display_id: Number(o.display_id),
        datum: new Date(o.created_at).toISOString().slice(0, 10),
        email: String(o.email ?? ""),
        bedrag: orderBedrag,
        provider,
      });
      const kort = provider.replace(/^pp_/, "");
      const rec = perProvider.get(kort) ?? { aantal: 0, bedrag: 0 };
      rec.aantal++;
      rec.bedrag += orderBedrag;
      perProvider.set(kort, rec);
    }
  }

  betaaldeOrders.sort((a, b) => a.display_id - b.display_id);

  logger.info(`\n===== TOTAAL BETAALD (${betaaldeOrders.length} betaalde orders) =====`);
  for (const b of betaaldeOrders) {
    logger.info(
      `  #${b.display_id}  ${b.datum}  ${eur(b.bedrag).padStart(10)}  ${b.provider.replace(/^pp_/, "")}  ${b.email}`
    );
  }
  logger.info(`\nPer betaalmethode:`);
  for (const [prov, rec] of perProvider.entries()) {
    logger.info(`  ${prov}: ${rec.aantal} orders, ${eur(rec.bedrag)}`);
  }
  if (totaalRefund > 0) {
    logger.info(`\nTerugbetaald: ${eur(totaalRefund)} (netto: ${eur(totaal - totaalRefund)})`);
  }
  logger.info(`\nTOTAAL ONTVANGEN: ${eur(totaal)}`);

  const onbetaald = geldig.length - betaaldeOrders.length;
  if (onbetaald > 0) {
    logger.info(`(${onbetaald} orders nog zonder betaling — niet meegeteld)`);
  }
  logger.info(`===== EIND =====\n`);
}
