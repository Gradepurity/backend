import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  BEDRIJF,
  SKIP_DISPLAY_IDS,
  eur,
  jaarDir,
  splitsBtw,
} from "./boekhouding-config";

/**
 * Genereert genummerde verkoopfacturen (HTML + PDF) uit Medusa-orders in
 * administratie/<jaar>/verkoopfacturen/. Nummering is doorlopend en wordt
 * vastgelegd in facturen-register.json zodat een her-run NOOIT hernummert.
 *
 * Order-items komen via de order-moduleservice (query.graph geeft geen
 * quantity/item-totalen terug); het ordertotaal komt uit summary.current_order_total.
 *
 * Draaien (vanuit apps/backend):
 *   npx medusa exec ./src/scripts/facturen-genereren.ts            → alles genereren
 *   npx medusa exec ./src/scripts/facturen-genereren.ts dry        → tonen wat er zou gebeuren, niets schrijven
 *
 * Check vóór de eerste echte run SKIP_DISPLAY_IDS in boekhouding-config.ts
 * (testorders horen geen factuurnummer te krijgen).
 */

type RegisterEntry = {
  nummer: string;
  display_id: number;
  datum: string;
};

type Register = {
  laatste_volgnummer: number;
  orders: Record<string, RegisterEntry>;
};

const EDGE_PADEN = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

export default async function facturenGenereren({
  container,
  args,
}: {
  container: MedusaContainer;
  args?: string[];
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const orderService: any = container.resolve(Modules.ORDER);
  const dry = (args ?? []).includes("dry");

  const orders = await orderService.listOrders(
    {},
    {
      select: ["id", "display_id", "status", "email", "created_at", "currency_code"],
      relations: ["items", "shipping_methods", "shipping_address", "billing_address"],
      take: 5000,
    }
  );

  // Ordertotalen zijn alleen betrouwbaar via de summary (query.graph).
  const { data: summaries } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "summary.*",
      "payment_collections.payments.captured_at",
    ],
  });
  const totaalPerOrder = new Map<string, number>(
    (summaries as any[]).map((s) => [s.id, Number(s.summary?.current_order_total ?? 0)])
  );
  // Laatste capture-datum per order → "Betaald op ..." op de factuur.
  const betaaldPerOrder = new Map<string, string>();
  for (const s of summaries as any[]) {
    for (const pc of s.payment_collections ?? []) {
      for (const p of pc.payments ?? []) {
        if (p.captured_at) {
          const d = new Date(p.captured_at).toISOString().slice(0, 10);
          const huidig = betaaldPerOrder.get(s.id);
          if (!huidig || d > huidig) betaaldPerOrder.set(s.id, d);
        }
      }
    }
  }

  const factuurbaar = (orders as any[])
    .filter((o) => o.status !== "canceled" && o.status !== "draft")
    .filter((o) => !SKIP_DISPLAY_IDS.includes(Number(o.display_id)))
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  if (factuurbaar.length === 0) {
    logger.info("Geen factuurbare orders gevonden.");
    return;
  }

  // Register laden — per jaar één register + één doorlopende nummerreeks.
  const jaar = new Date(factuurbaar[0].created_at).getFullYear();
  const uitDir = path.join(jaarDir(jaar), "verkoopfacturen");
  const registerPad = path.join(uitDir, "facturen-register.json");
  const register: Register = fs.existsSync(registerPad)
    ? JSON.parse(fs.readFileSync(registerPad, "utf8"))
    : { laatste_volgnummer: 0, orders: {} };

  const edge = EDGE_PADEN.find((p) => fs.existsSync(p));
  if (!edge) logger.warn("Edge niet gevonden — alleen HTML, geen PDF.");
  if (!dry) fs.mkdirSync(uitDir, { recursive: true });

  let nieuw = 0;
  for (const o of factuurbaar) {
    const oJaar = new Date(o.created_at).getFullYear();
    if (oJaar !== jaar) {
      logger.warn(
        `Order #${o.display_id} valt in ${oJaar}, register is van ${jaar} — draai het script opnieuw in het nieuwe jaar.`
      );
      continue;
    }

    let entry = register.orders[o.id];
    const bestondAl = Boolean(entry);
    if (!entry) {
      register.laatste_volgnummer += 1;
      entry = {
        nummer: `${jaar}-${String(register.laatste_volgnummer).padStart(4, "0")}`,
        display_id: Number(o.display_id),
        datum: new Date(o.created_at).toISOString().slice(0, 10),
      };
      register.orders[o.id] = entry;
      nieuw++;
    }

    const totaal = totaalPerOrder.get(o.id) ?? 0;
    const basisnaam = `factuur-${entry.nummer}-order-${o.display_id}`;
    const htmlPad = path.join(uitDir, `${basisnaam}.html`);
    const pdfPad = path.join(uitDir, `${basisnaam}.pdf`);
    const status = bestondAl && fs.existsSync(pdfPad) ? "bestond al" : "NIEUW";

    logger.info(
      `${entry.nummer} | order #${o.display_id} | ${entry.datum} | ${o.email} | ${eur(totaal)} | ${status}${dry ? " (dry)" : ""}`
    );
    if (dry || (bestondAl && fs.existsSync(pdfPad))) continue;

    fs.writeFileSync(htmlPad, factuurHtml(o, entry, totaal, betaaldPerOrder.get(o.id)), "utf8");
    if (edge) {
      try {
        execFileSync(edge, [
          "--headless",
          "--disable-gpu",
          // Eigen profielmap: zonder deze hangt headless Edge zolang de
          // gewone browser met het standaardprofiel open staat.
          `--user-data-dir=${path.join(os.tmpdir(), "gp-factuur-pdf")}`,
          "--no-pdf-header-footer",
          `--print-to-pdf=${pdfPad}`,
          `file:///${htmlPad.replace(/\\/g, "/")}`,
        ]);
      } catch (e: any) {
        logger.warn(`PDF mislukt voor ${entry.nummer}: ${e?.message ?? e}`);
      }
    }
  }

  if (!dry) {
    fs.writeFileSync(registerPad, JSON.stringify(register, null, 2), "utf8");
  }
  logger.info(
    `\nKlaar: ${nieuw} nieuwe factuurnummer(s), ${Object.keys(register.orders).length} totaal in register.${dry ? " (dry-run — niets geschreven)" : ` Map: ${uitDir}`}`
  );
}

type Lang = "nl" | "de";

const TEKSTEN: Record<Lang, Record<string, string>> = {
  nl: {
    factuur: "Factuur",
    factuurAan: "Factuur aan",
    gegevens: "Gegevens",
    factuurnummer: "Factuurnummer",
    factuurdatum: "Factuurdatum",
    ordernummer: "Ordernummer",
    status: "Status",
    betaald: "Betaald",
    omschrijving: "Omschrijving",
    aantal: "Aantal",
    stukprijs: "Stukprijs excl.",
    exclBtw: "Excl. btw",
    btw: "Btw 21%",
    verzendkosten: "Verzendkosten",
    korting: "Korting",
    toeslag: "Toeslag",
    totaalExcl: "Totaal excl. btw",
    totaal: "Totaal",
    voldaanVoor: "Reeds voldaan op",
    voldaanNa: "— u hoeft niets meer te betalen.",
  },
  de: {
    factuur: "Rechnung",
    factuurAan: "Rechnung an",
    gegevens: "Angaben",
    factuurnummer: "Rechnungsnummer",
    factuurdatum: "Rechnungsdatum",
    ordernummer: "Bestellnummer",
    status: "Status",
    betaald: "Bezahlt",
    omschrijving: "Beschreibung",
    aantal: "Menge",
    stukprijs: "Stückpreis netto",
    exclBtw: "Netto",
    btw: "MwSt. 21%",
    verzendkosten: "Versandkosten",
    korting: "Rabatt",
    toeslag: "Zuschlag",
    totaalExcl: "Gesamt netto",
    totaal: "Gesamt",
    voldaanVoor: "Bereits bezahlt am",
    voldaanNa: "— es ist keine Zahlung mehr erforderlich.",
  },
};

// Productnamen staan in het Nederlands in Medusa; bekende titels vertalen we op de DE-factuur.
const PRODUCT_DE: Record<string, string> = {
  "Bacteriostatisch water 3ml (inbegrepen)": "Bakteriostatisches Wasser 3ml (inklusive)",
};

function factuurHtml(o: any, entry: RegisterEntry, orderTotaal: number, betaaldOp?: string): string {
  const adres = o.billing_address ?? o.shipping_address ?? {};
  const lang: Lang = (adres.country_code ?? "").toLowerCase() === "de" ? "de" : "nl";
  const t = TEKSTEN[lang];
  const klantNaam =
    [adres.first_name, adres.last_name].filter(Boolean).join(" ") || o.email;
  const klantRegels = [
    adres.company,
    klantNaam,
    [adres.address_1, adres.address_2].filter(Boolean).join(" "),
    [adres.postal_code, adres.city].filter(Boolean).join("  "),
    (adres.country_code ?? "").toUpperCase(),
  ]
    .filter(Boolean)
    .map(esc);

  const regels: string[] = [];
  let regelsIncl = 0;
  for (const it of o.items ?? []) {
    const aantal = Number(it.quantity ?? 1);
    const incl = Math.round(Number(it.unit_price ?? 0) * aantal * 100) / 100;
    regelsIncl += incl;
    const { excl, btw } = splitsBtw(incl);
    // Variant (bv. "10 mg vial") erbij; "Standaard" is een niet-informatieve default.
    let naam = it.product_title ?? it.title;
    if (lang === "de" && PRODUCT_DE[naam]) naam = PRODUCT_DE[naam];
    const variant = it.variant_title && it.variant_title !== "Standaard" ? ` — ${it.variant_title}` : "";
    regels.push(rij(`${naam}${variant}`, aantal, excl / aantal, excl, btw));
  }
  const verzendIncl = (o.shipping_methods ?? []).reduce(
    (som: number, m: any) => som + Number(m.amount ?? 0),
    0
  );
  if (verzendIncl > 0) {
    const { excl, btw } = splitsBtw(verzendIncl);
    regels.push(rij(t.verzendkosten, 1, excl, excl, btw));
    regelsIncl += verzendIncl;
  }
  // Vangnet voor kortingen/afwijkingen: alles wat het ordertotaal nog niet dekt.
  const rest = Math.round((orderTotaal - regelsIncl) * 100) / 100;
  if (Math.abs(rest) >= 0.01) {
    const { excl, btw } = splitsBtw(rest);
    regels.push(rij(rest < 0 ? t.korting : t.toeslag, 1, excl, excl, btw));
  }

  const totaal = splitsBtw(orderTotaal);

  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<title>${t.factuur} ${entry.nummer}</title>
<style>
  @page { size: A4; margin: 0; }
  body { font-family: "Segoe UI", Arial, sans-serif; color: #14171c; margin: 0; }
  .vel { padding: 22mm 20mm; }
  .kop { display: flex; justify-content: space-between; align-items: baseline;
         border-bottom: 2px solid #1F3F6E; padding-bottom: 10px; }
  .merk { font-size: 22px; letter-spacing: 3px; font-weight: 600; color: #1F3F6E; text-transform: uppercase; }
  h1 { font-size: 15px; letter-spacing: 2px; text-transform: uppercase; margin: 0; }
  .blokken { display: flex; justify-content: space-between; margin: 28px 0; font-size: 12.5px; line-height: 1.6; }
  .label { font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: #6b7280; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th { text-align: left; font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase;
       color: #6b7280; border-bottom: 1px solid #d1d5db; padding: 6px 8px; }
  td { padding: 7px 8px; border-bottom: 1px solid #eef0f3; }
  .r { text-align: right; }
  .totalen { margin-top: 14px; margin-left: auto; width: 62mm; font-size: 12.5px; }
  .totalen div { display: flex; justify-content: space-between; padding: 3px 8px; }
  .totalen .eind { border-top: 2px solid #1F3F6E; font-weight: 600; margin-top: 4px; padding-top: 7px; }
  .voldaan { margin-top: 10px; text-align: right; font-size: 11.5px; font-weight: 600; color: #1F3F6E; }
  .voet { margin-top: 36px; padding-top: 12px; border-top: 1px solid #d1d5db;
          font-size: 10.5px; color: #6b7280; line-height: 1.7; }
</style></head>
<body><div class="vel">
  <div class="kop"><div class="merk">${esc(BEDRIJF.naam)}</div><h1>${t.factuur}</h1></div>
  <div class="blokken">
    <div><div class="label">${t.factuurAan}</div>${klantRegels.join("<br>")}<br>${esc(o.email ?? "")}</div>
    <div><div class="label">${t.gegevens}</div>
      ${t.factuurnummer}: <b>${entry.nummer}</b><br>
      ${t.factuurdatum}: ${entry.datum}<br>
      ${t.ordernummer}: #${o.display_id}${betaaldOp ? `<br>${t.status}: <b>${t.betaald}</b> (${esc(datum(betaaldOp, lang))})` : ""}
    </div>
  </div>
  <table>
    <tr><th>${t.omschrijving}</th><th class="r">${t.aantal}</th><th class="r">${t.stukprijs}</th><th class="r">${t.exclBtw}</th><th class="r">${t.btw}</th></tr>
    ${regels.join("\n    ")}
  </table>
  <div class="totalen">
    <div><span>${t.totaalExcl}</span><span>${eur(totaal.excl)}</span></div>
    <div><span>${t.btw}</span><span>${eur(totaal.btw)}</span></div>
    <div class="eind"><span>${t.totaal}</span><span>${eur(orderTotaal)}</span></div>
  </div>
  ${betaaldOp ? `<div class="voldaan">${t.voldaanVoor} ${esc(datum(betaaldOp, lang))} ${t.voldaanNa}</div>` : ""}
  <div class="voet">
    ${esc(BEDRIJF.naam)}<br>
    KvK ${esc(BEDRIJF.kvk)} · IBAN ${esc(BEDRIJF.iban)} (BIC ${esc(BEDRIJF.bic)})<br>
    ${esc(BEDRIJF.email)} · ${esc(BEDRIJF.site)}
  </div>
</div></body></html>`;
}

function rij(oms: string, aantal: number, stukExcl: number, excl: number, btw: number): string {
  return `<tr><td>${esc(oms)}</td><td class="r">${aantal}</td><td class="r">${eur(Math.round(stukExcl * 100) / 100)}</td><td class="r">${eur(excl)}</td><td class="r">${eur(btw)}</td></tr>`;
}

function datum(iso: string, lang: Lang): string {
  const [j, m, d] = iso.split("-");
  const sep = lang === "de" ? "." : "-";
  return `${d}${sep}${m}${sep}${j}`;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}
