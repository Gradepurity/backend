import path from "path";

/**
 * Gedeelde instellingen voor de boekhoud-scripts
 * (facturen-genereren.ts en btw-kwartaal.ts).
 */

// Bedrijfsgegevens zoals ze op de factuur komen. Facturen zijn intern
// (eigen administratie, KvK-vestigingsadres mag hier) — klanten krijgen
// alleen de bevestigingsmail.
export const BEDRIJF = {
  naam: "Gradepurity",
  adres: "Oslostraat 66, 6135 LM Sittard",
  kvk: "42106879",
  btwId: "NL005498490B56",
  // Omzetbelastingnummer — alleen voor de aangifte zelf, staat niet op facturen.
  obNummer: "218854626B02",
  iban: "NL81FNOM0779175917",
  bic: "FNOMNL22",
  email: "info@gradepurity.com",
  site: "gradepurity.com",
};

// NL BTW-tarief; alle catalogusprijzen zijn inclusief.
export const BTW_TARIEF = 0.21;

// Orders die geen factuur horen te krijgen (display_id's van testorders).
// Alle orders t/m 13-07-2026 waren Testproduct-tests (bevestigd door klant).
// 1948-1950 + 1960-1961: BANKpay+ e2e-tests 29-07. 1936 + 1962: eigen
// testorders via info@gradepurity.com. Alle verwijderd 30-07; facturen
// 2026-1873, 1880-1882 en 1886 vervallen, zie notitie in verkoopfacturen/.
export const SKIP_DISPLAY_IDS: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 1936, 1948, 1949, 1950, 1960, 1961, 1962];

// Waar de administratie-map staat, relatief aan apps/backend (= cwd bij `medusa exec`).
// Overschrijfbaar met ADMINISTRATIE_DIR in .env.
export const ADMINISTRATIE_DIR =
  process.env.ADMINISTRATIE_DIR ??
  path.resolve(process.cwd(), "..", "..", "..", "administratie");

export function jaarDir(jaar: number): string {
  return path.join(ADMINISTRATIE_DIR, String(jaar));
}

export function eur(bedrag: number): string {
  return (
    "€ " +
    bedrag.toLocaleString("nl-NL", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

/** Splitst een bedrag inclusief BTW in excl + btw (afgerond op centen). */
export function splitsBtw(incl: number): { excl: number; btw: number } {
  const excl = Math.round((incl / (1 + BTW_TARIEF)) * 100) / 100;
  return { excl, btw: Math.round((incl - excl) * 100) / 100 };
}
