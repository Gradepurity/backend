import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import fs from "fs";
import path from "path";

/**
 * Exporteert de gemiste purchase-conversies (30–31 juli, conversie-gat door de
 * wachtpagina-flow) als CSV voor de handmatige Google Ads-upload (Doelen →
 * Conversies → Uploads, "Conversies uit klikken" met user-provided data).
 * Alleen betaalde (gecapturede), niet-geannuleerde klantorders; testorders
 * (skiplist boekhouding) worden overgeslagen. Google hasht de e-mail zelf bij
 * de UI-upload, dus plaintext in de CSV is correct.
 *   npx medusa exec ./src/scripts/export-conversie-csv.ts <van> <tot> [actienaam]
 *   npx medusa exec ./src/scripts/export-conversie-csv.ts 2026-07-30 2026-07-31
 */

// Spiegel van SKIP_DISPLAY_IDS-gedachte: geen conversies voor eigen tests.
import { SKIP_DISPLAY_IDS } from "./boekhouding-config";

export default async function exportConversieCsv({ container, args }: ExecArgs) {
  const logger = container.resolve("logger");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const van = args?.[0];
  const tot = args?.[1];
  const actieNaam = args?.[2] ?? "Purchase import (backfill)";
  if (!van || !tot) {
    logger.error("Gebruik: medusa exec ./src/scripts/export-conversie-csv.ts <van YYYY-MM-DD> <tot YYYY-MM-DD>");
    return;
  }
  const start = new Date(`${van}T00:00:00+02:00`);
  const eind = new Date(`${tot}T23:59:59+02:00`);

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "status",
      "email",
      "created_at",
      "currency_code",
      "summary.current_order_total",
      "shipping_address.phone",
      "shipping_address.first_name",
      "shipping_address.last_name",
      "shipping_address.postal_code",
      "shipping_address.country_code",
      "payment_collections.payments.captured_at",
    ],
    filters: { status: "pending" } as any,
  });

  const rows: string[] = [];
  // Google's template "Conversions from clicks (user-provided data)" kent
  // ALLEEN deze kolommen — extra kolommen (naam/postcode/land) laten de
  // parser de hele file negeren ("No changes", geleerd 31-07). Tijden dragen
  // een inline GMT-offset; de Parameters-regel is de sjabloon-conventie.
  rows.push("Parameters:TimeZone=+0200");
  rows.push(
    [
      "Email",
      "Phone Number",
      "Conversion Name",
      "Conversion Time",
      "Conversion Value",
      "Conversion Currency",
      "Order ID",
    ].join(",")
  );

  const selectie = (orders as any[])
    .filter((o) => {
      const t = new Date(o.created_at);
      return t >= start && t <= eind;
    })
    .filter((o) => !SKIP_DISPLAY_IDS.includes(Number(o.display_id)))
    .filter((o) =>
      (o.payment_collections ?? [])
        .flatMap((pc: any) => pc.payments ?? [])
        .some((p: any) => p.captured_at)
    )
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  // summary.current_order_total komt in lijst-queries als 0 terug (bekende
  // quirk) — totalen daarom per order apart opvragen (single-id werkt wél).
  const totalen = new Map<string, number>();
  for (const o of selectie) {
    const { data: single } = await query.graph({
      entity: "order",
      // Wildcard verplicht: het losse veld summary.current_order_total komt
      // als 0 terug (zelfde les als in facturen-genereren.ts).
      fields: ["id", "summary.*"],
      filters: { id: o.id },
    });
    totalen.set(o.id, Number((single as any[])[0]?.summary?.current_order_total ?? 0));
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  for (const o of selectie) {
    const a = o.shipping_address ?? {};
    const t = new Date(o.created_at);
    // Conversietijd in NL-tijd met expliciete offset (juli = UTC+2).
    const nl = new Date(t.getTime() + 2 * 60 * 60 * 1000);
    const tijd = `${nl.getUTCFullYear()}-${pad(nl.getUTCMonth() + 1)}-${pad(nl.getUTCDate())} ${pad(nl.getUTCHours())}:${pad(nl.getUTCMinutes())}:${pad(nl.getUTCSeconds())}+0200`;
    // Telefoon in E.164 waar mogelijk (verhoogt matchkans); landcode uit het
    // verzendland afleiden voor nummers die met 0 beginnen; anders leeg laten.
    const rawPhone = String(a.phone ?? "").replace(/[^\d+]/g, "");
    const landPrefix: Record<string, string> = { nl: "+31", be: "+32", de: "+49", fr: "+33" };
    const cc = String(a.country_code ?? "").toLowerCase();
    const phone = rawPhone.startsWith("+")
      ? rawPhone
      : rawPhone.startsWith("0") && landPrefix[cc]
        ? `${landPrefix[cc]}${rawPhone.slice(1)}`
        : "";
    const totaal = (totalen.get(o.id) ?? 0).toFixed(2);
    rows.push(
      [
        o.email ?? "",
        phone,
        actieNaam,
        tijd,
        totaal,
        String(o.currency_code ?? "eur").toUpperCase(),
        `GP-${String(o.display_id).padStart(5, "0")}`,
      ]
        .map((v) => (String(v).includes(",") ? `"${v}"` : v))
        .join(",")
    );
    logger.info(
      `  #${o.display_id} | ${tijd} | ${o.email} | €${totaal} | ${String(a.country_code ?? "").toUpperCase()}`
    );
  }

  const uitPad = path.resolve(process.cwd(), `conversie-backfill-${van}-tot-${tot}.csv`);
  fs.writeFileSync(uitPad, rows.join("\n"), "utf8");
  logger.info(`\n${selectie.length} conversie(s) geëxporteerd -> ${uitPad}`);
  logger.info(`Conversieactie-naam in de CSV: "${actieNaam}" — moet exact matchen met de import-actie in Ads.`);
}
