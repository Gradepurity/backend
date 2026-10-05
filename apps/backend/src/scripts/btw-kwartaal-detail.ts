import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { SKIP_DISPLAY_IDS, eur } from "./boekhouding-config";

/**
 * READ-ONLY: controle-overzicht per order bij btw-kwartaal.ts. Toont per order
 * in het kwartaal het orderbedrag, wat er echt gecaptured is, refunds en de
 * verzendstatus, zodat je de omzet in rubriek 1a kunt verantwoorden.
 *
 * Draaien (vanuit apps/backend):
 *   npx medusa exec ./src/scripts/btw-kwartaal-detail.ts 2026-Q3
 */
export default async function btwKwartaalDetail({
  container,
  args,
}: {
  container: MedusaContainer;
  args?: string[];
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const nu = new Date();
  const arg = (args ?? []).find((a) => /^\d{4}-Q[1-4]$/i.test(a));
  const jaar = arg ? Number(arg.slice(0, 4)) : nu.getFullYear();
  const kwartaal = arg ? Number(arg.slice(6)) : Math.floor(nu.getMonth() / 3) + 1;
  const start = new Date(Date.UTC(jaar, (kwartaal - 1) * 3, 1));
  const eind = new Date(Date.UTC(jaar, kwartaal * 3, 1));

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "status",
      "created_at",
      "canceled_at",
      "summary.*",
      "shipping_address.country_code",
      "fulfillments.shipped_at",
      "fulfillments.canceled_at",
      "payment_collections.payments.provider_id",
      "payment_collections.payments.canceled_at",
      "payment_collections.payments.captured_at",
      "payment_collections.payments.captures.amount",
      "payment_collections.payments.refunds.amount",
    ],
    pagination: { take: 5000, skip: 0 } as any,
  });

  // Ruime marge rond de kwartaalgrens: UTC vs. NL-tijd scheelt 1-2 uur.
  const marge = 3 * 3600 * 1000;
  const rond = (orders as any[])
    .filter((o) => {
      const t = new Date(o.created_at).getTime();
      return t >= start.getTime() - marge && t < eind.getTime() + marge;
    })
    .sort((a, b) => Number(a.display_id) - Number(b.display_id));

  const nlDatum = (d: any) =>
    new Date(d).toLocaleString("nl-NL", {
      timeZone: "Europe/Amsterdam",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

  logger.info(`\n===== BTW-DETAIL ${jaar} Q${kwartaal} (${rond.length} orders incl. geannuleerd/skip) =====`);
  logger.info(`#id | datum (NL) | land | status | orderbedrag | captured | refund | provider | verzonden | opmerking`);

  let somOrder = 0;
  let somCaptured = 0;
  let somRefund = 0;
  let aantalMee = 0;
  for (const o of rond) {
    const id = Number(o.display_id);
    const t = new Date(o.created_at);
    const inUtcKwartaal = t >= start && t < eind;
    const bedrag = Number(o.summary?.current_order_total ?? 0);
    let captured = 0;
    let refund = 0;
    let provider = "";
    let capturedAt: any = null;
    for (const pc of o.payment_collections ?? []) {
      for (const p of pc.payments ?? []) {
        if (p.canceled_at) continue;
        provider = String(p.provider_id ?? "").replace(/^pp_/, "");
        captured += (p.captures ?? []).reduce((s: number, c: any) => s + Number(c.amount ?? 0), 0);
        refund += (p.refunds ?? []).reduce((s: number, r: any) => s + Number(r.amount ?? 0), 0);
        if (p.captured_at) capturedAt = p.captured_at;
      }
    }
    const verzonden = (o.fulfillments ?? []).some((f: any) => f.shipped_at && !f.canceled_at);

    const opm: string[] = [];
    const skip = SKIP_DISPLAY_IDS.includes(id);
    const telt = inUtcKwartaal && !skip && o.status !== "canceled" && o.status !== "draft";
    if (skip) opm.push("SKIP_DISPLAY_IDS");
    if (o.status === "canceled") opm.push("geannuleerd");
    if (!inUtcKwartaal) opm.push("buiten kwartaal (UTC)");
    if (telt && captured === 0) opm.push("NIET BETAALD");
    if (telt && captured > 0 && Math.abs(captured - bedrag) > 0.005) opm.push("captured != orderbedrag");
    if (telt && !verzonden) opm.push("niet verzonden");
    if (capturedAt && !(new Date(capturedAt) >= start && new Date(capturedAt) < eind)) {
      opm.push(`betaald buiten kwartaal (${nlDatum(capturedAt)})`);
    }

    if (telt) {
      aantalMee++;
      somOrder += bedrag;
      somCaptured += captured;
      somRefund += refund;
    }

    logger.info(
      `#${id} | ${nlDatum(o.created_at)} | ${String(o.shipping_address?.country_code ?? "-").toUpperCase()} | ${o.status} | ` +
        `${eur(bedrag)} | ${eur(captured)} | ${eur(refund)} | ${provider || "-"} | ${verzonden ? "ja" : "nee"} | ` +
        `${telt ? "TELT MEE" : "telt niet"}${opm.length ? " - " + opm.join(", ") : ""}`
    );
  }

  logger.info(`\nTelt mee in btw-kwartaal.ts: ${aantalMee} orders`);
  logger.info(`  som orderbedragen: ${eur(somOrder)}`);
  logger.info(`  som captured:      ${eur(somCaptured)}`);
  logger.info(`  som refunds:       ${eur(somRefund)}`);
  logger.info(`===== EIND =====\n`);
}
