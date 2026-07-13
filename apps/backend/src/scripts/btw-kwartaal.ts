import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import fs from "fs";
import path from "path";
import { SKIP_DISPLAY_IDS, eur, jaarDir, splitsBtw } from "./boekhouding-config";

/**
 * BTW-kwartaaloverzicht: telt de omzet uit Medusa-orders op en spuugt precies
 * de rubrieken uit die je invult in Mijn Belastingdienst Zakelijk.
 * Voorbelasting (5b) komt uit administratie/<jaar>/kosten.csv als die bestaat.
 * Bewaakt ook de OSS-drempel (EUR 10.000 EU-brede B2C-omzet buiten NL, per kalenderjaar).
 *
 * Draaien (vanuit apps/backend):
 *   npx medusa exec ./src/scripts/btw-kwartaal.ts            -> huidig kwartaal
 *   npx medusa exec ./src/scripts/btw-kwartaal.ts 2026-Q3    -> specifiek kwartaal
 */

const OSS_DREMPEL = 10000;
const EU = new Set([
  "at","be","bg","hr","cy","cz","dk","ee","fi","fr","de","gr","hu","ie","it",
  "lv","lt","lu","mt","pl","pt","ro","sk","si","es","se",
]);

export default async function btwKwartaal({
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
      "summary.*",
      "shipping_address.country_code",
    ],
  });

  const geldig = (orders as any[])
    .filter((o) => o.status !== "canceled" && o.status !== "draft")
    .filter((o) => !SKIP_DISPLAY_IDS.includes(Number(o.display_id)));

  const inKwartaal = geldig.filter((o) => {
    const d = new Date(o.created_at);
    return d >= start && d < eind;
  });

  logger.info(`\n===== BTW-OVERZICHT ${jaar} Q${kwartaal} (${inKwartaal.length} orders) =====`);

  // Omzet per land (levering = bestemmingsland van de klant).
  const perLand = new Map<string, { aantal: number; incl: number }>();
  let omzetIncl = 0;
  for (const o of inKwartaal) {
    const land = String(o.shipping_address?.country_code ?? "nl").toLowerCase();
    const incl = Number(o.summary?.current_order_total ?? 0);
    omzetIncl += incl;
    const rec = perLand.get(land) ?? { aantal: 0, incl: 0 };
    rec.aantal++;
    rec.incl += incl;
    perLand.set(land, rec);
  }
  for (const [land, rec] of [...perLand.entries()].sort((a, b) => b[1].incl - a[1].incl)) {
    logger.info(`  ${land.toUpperCase()}: ${rec.aantal} orders, ${eur(rec.incl)} incl. btw`);
  }

  const totaal = splitsBtw(omzetIncl);
  logger.info(`\nOmzet incl. btw: ${eur(omzetIncl)}`);
  logger.info(`-- Voor de aangifte (bedragen in hele euro's) --`);
  logger.info(`Rubriek 1a - Leveringen belast met hoog tarief:`);
  logger.info(`    omzet (excl.): EUR ${Math.round(totaal.excl)}`);
  logger.info(`    btw:           EUR ${Math.round(totaal.btw)}`);

  // Voorbelasting uit kosten.csv (kolommen: datum;omschrijving;categorie;bedrag_incl;btw_bedrag;terugvorderbaar).
  const kostenPad = path.join(jaarDir(jaar), "kosten.csv");
  if (fs.existsSync(kostenPad)) {
    let voorbelasting = 0;
    let kostenIncl = 0;
    let rijen = 0;
    const regels = fs.readFileSync(kostenPad, "utf8").split(/\r?\n/).slice(1);
    for (const regel of regels) {
      if (!regel.trim()) continue;
      const [datum, , , bedragIncl, btwBedrag, terugvorderbaar] = regel.split(";");
      const d = new Date(datum);
      if (!(d >= start && d < eind)) continue;
      rijen++;
      kostenIncl += parseNl(bedragIncl);
      if ((terugvorderbaar ?? "").trim().toLowerCase() === "ja") {
        voorbelasting += parseNl(btwBedrag);
      }
    }
    logger.info(`Rubriek 5b - Voorbelasting: EUR ${Math.round(voorbelasting)}   (${rijen} kostenregels, ${eur(kostenIncl)} incl.)`);
    logger.info(`TE BETALEN: EUR ${Math.round(totaal.btw) - Math.round(voorbelasting)}`);
  } else {
    logger.info(`Rubriek 5b - Voorbelasting: geen kosten.csv gevonden (${kostenPad}) - zelf optellen.`);
  }

  // OSS-drempelbewaking: hele kalenderjaar, EU-landen behalve NL.
  let euBuitenNl = 0;
  for (const o of geldig) {
    const d = new Date(o.created_at);
    if (d.getUTCFullYear() !== jaar) continue;
    const land = String(o.shipping_address?.country_code ?? "nl").toLowerCase();
    if (land !== "nl" && EU.has(land)) euBuitenNl += Number(o.summary?.current_order_total ?? 0);
  }
  logger.info(`\nOSS-drempel: ${eur(euBuitenNl)} van ${eur(OSS_DREMPEL)} EU-omzet buiten NL in ${jaar}.`);
  if (euBuitenNl > OSS_DREMPEL * 0.8) {
    logger.warn(
      euBuitenNl >= OSS_DREMPEL
        ? "LET OP: DREMPEL OVERSCHREDEN - vanaf nu lokale btw-tarieven rekenen en OSS-registratie regelen."
        : "LET OP: drempel nadert (>80%) - OSS-registratie voorbereiden."
    );
  }
  logger.info(`===== EIND =====\n`);
}

/** Accepteert zowel NL-notatie (1.234,56) als punt-decimalen (1234.56). */
function parseNl(s: string | undefined): number {
  if (!s) return 0;
  const t = String(s).trim();
  const genormaliseerd = t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t;
  return Number(genormaliseerd) || 0;
}
