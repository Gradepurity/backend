import path from "path";

/**
 * Gedeelde instellingen voor de boekhoud-scripts
 * (facturen-genereren.ts en btw-kwartaal.ts).
 */

// Bedrijfsgegevens zoals ze op de factuur komen. Facturen zijn intern
// (eigen administratie) — klanten krijgen alleen de bevestigingsmail.
export const BEDRIJF = {
  naam: "Gradepurity",
  kvk: "42106879",
  // TODO: BTW-id invullen (staat op de brief van de Belastingdienst na KvK-inschrijving).
  btwId: process.env.GP_BTW_ID ?? "",
  iban: "NL81FNOM0779175917",
  bic: "FNOMNL22",
  email: "info@gradepurity.com",
  site: "gradepurity.com",
};

// NL BTW-tarief; alle catalogusprijzen zijn inclusief.
export const BTW_TARIEF = 0.21;

// Orders die geen factuur horen te krijgen (display_id's van bijv. testorders).
// Vul dit VÓÓR de eerste echte (niet-dry) run — factuurnummers zijn daarna definitief.
export const SKIP_DISPLAY_IDS: number[] = [];

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
