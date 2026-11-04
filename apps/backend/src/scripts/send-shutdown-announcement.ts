import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { renderLayout, escapeHtml, UI } from "../modules/resend/templates/layout";
import * as fs from "fs";
import * as path from "path";

/**
 * Stop-aankondiging (04-11-2026): website offline per 5 november, lopende orders
 * worden nog geleverd, daarna alleen bestellen via WhatsApp.
 * Ontvangers = alle unieke e-mails uit orders + klantrecords, zonder test-/eigen adressen.
 * NL/BE → nl, DE → de; onbekend land → DE bij Duits maildomein, anders nl.
 *
 *   npx medusa exec ./src/scripts/send-shutdown-announcement.ts         → dry-run (lijst + previews)
 *   npx medusa exec ./src/scripts/send-shutdown-announcement.ts send    → echt versturen
 *
 * Verzonden adressen worden gelogd in shutdown-mail-sent.json; een her-run slaat die over.
 */

const EXCLUDE = /webreaktor|gradepurity|example\.|^test|smoke|acctcheck|@out\.com$|\.local$/i;
// Handmatig nagelopen 04-11: testinvoer / ongeldige domeinen / klant-testaccount (touchofesthetic = ander project).
const EXCLUDE_EXACT = new Set([
  "ab@email.com",
  "dikzak@gmail.com",
  "qzdqzd@gmail.com",
  "t@x.fr",
  "werktdit@outlook.com",
  "touchofesthetic@gmail.co",
  "touchofesthetic@gmail.com",
]);
// Land onbekend in Medusa, wel bekend uit eerdere correspondentie.
const LOCALE_OVERRIDE: Record<string, Locale> = { "draganfljorija@hotmail.com": "de" };
// Voornamen die als aanhef raar staan → geen naam gebruiken.
const BAD_NAMES = /^(mogging|test|a\.?)$/i;
const DE_DOMAINS = /(\.de|\.at)$|@(gmx\.net|gmx\.ch)$/i;
const WA_LINK = `<a href="https://wa.me/31615605502" style="color:${UI.navy};font-weight:700;">+31 6 15 60 55 02</a>`;

type Locale = "nl" | "de";
type Recipient = { email: string; firstName: string; locale: Locale; country: string };

function cap(s: string) {
  const t = s.trim().split(/\s+/)[0] ?? "";
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}

function buildEmail(r: Recipient) {
  const name = r.firstName ? ` ${escapeHtml(r.firstName)}` : "";
  let subject: string, preheader: string, heading: string, body: string;

  if (r.locale === "de") {
    subject = "GradePurity schließt, die Website geht am 5. November offline";
    preheader = "Offene Bestellungen werden noch zugestellt. Danach nur noch per WhatsApp.";
    heading = "Wir stellen GradePurity ein.";
    body = `
<p style="margin:0 0 24px;">Hallo${name},</p>
<p style="margin:0 0 24px;">aufgrund der immer strengeren Vorgaben der Behörden haben wir uns entschieden, GradePurity einzustellen. Die Website geht morgen, am Donnerstag, 5. November, offline.</p>
<p style="margin:0 0 8px;"><strong>Was bedeutet das für dich?</strong></p>
<ul style="margin:0 0 24px;padding-left:20px;">
  <li style="margin:0 0 8px;">Du hast noch eine offene Bestellung? Die wird selbstverständlich noch zugestellt.</li>
  <li style="margin:0;">Ab dem 5. November sind Bestellungen nur noch per WhatsApp möglich: ${WA_LINK}</li>
</ul>
<p style="margin:0 0 24px;">Vielen Dank für dein Vertrauen in GradePurity.</p>
<p style="margin:0;">Viele Grüße<br/>Team GradePurity</p>`;
  } else {
    subject = "GradePurity stopt, de website gaat 5 november offline";
    preheader = "Lopende bestellingen leveren we gewoon af. Bestellen kan daarna via WhatsApp.";
    heading = "We stoppen met GradePurity.";
    body = `
<p style="margin:0 0 24px;">Hoi${name},</p>
<p style="margin:0 0 24px;">Door de steeds strengere houding van de overheid hebben we besloten om met GradePurity te stoppen. De website gaat morgen, donderdag 5 november, offline.</p>
<p style="margin:0 0 8px;"><strong>Wat betekent dit voor jou?</strong></p>
<ul style="margin:0 0 24px;padding-left:20px;">
  <li style="margin:0 0 8px;">Heb je nog een bestelling lopen? Die leveren we gewoon af.</li>
  <li style="margin:0;">Na 5 november kun je alleen nog bestellen via WhatsApp: ${WA_LINK}</li>
</ul>
<p style="margin:0 0 24px;">Bedankt voor je vertrouwen in GradePurity.</p>
<p style="margin:0;">Met vriendelijke groet,<br/>Team GradePurity</p>`;
  }

  // Footer-link naar gradepurity.com werkt na 5 november niet meer → vervangen door WhatsApp.
  let html = renderLayout({ preheader, heading, body }, r.locale);
  html = html.replace(
    /<a href="https:\/\/gradepurity\.com"[^>]*>gradepurity\.com<\/a>/,
    `WhatsApp ${WA_LINK.replace("font-weight:700;", "text-decoration:none;")}`
  );
  if (html.includes("https://gradepurity.com")) throw new Error("footer-link niet vervangen");
  return { subject, html };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default async function sendShutdownAnnouncement({ container, args }: ExecArgs) {
  const logger = container.resolve("logger");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const doSend = args?.[0] === "send";

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) {
    logger.error("RESEND_API_KEY / RESEND_FROM ontbreekt in env.");
    return;
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["display_id", "email", "shipping_address.first_name", "shipping_address.country_code"],
  });
  const { data: customers } = await query.graph({
    entity: "customer",
    fields: ["email", "first_name", "addresses.country_code"],
  });

  const map = new Map<string, Recipient & { lastId: number }>();
  for (const o of (orders as any[]).sort((a, b) => (a.display_id ?? 0) - (b.display_id ?? 0))) {
    const email = (o.email ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) continue;
    const country = (o.shipping_address?.country_code ?? "").toUpperCase();
    const prev = map.get(email);
    map.set(email, {
      email,
      firstName: cap(o.shipping_address?.first_name ?? "") || prev?.firstName || "",
      country: country || prev?.country || "",
      locale: "nl",
      lastId: o.display_id ?? 0,
    });
  }
  for (const c of customers as any[]) {
    const email = (c.email ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) continue;
    const prev = map.get(email);
    if (prev) {
      if (!prev.firstName) prev.firstName = cap(c.first_name ?? "");
      continue;
    }
    map.set(email, {
      email,
      firstName: cap(c.first_name ?? ""),
      country: ((c.addresses ?? [])[0]?.country_code ?? "").toUpperCase(),
      locale: "nl",
      lastId: 0,
    });
  }

  const excluded: string[] = [];
  const recipients: Recipient[] = [];
  for (const r of map.values()) {
    if (EXCLUDE.test(r.email) || EXCLUDE_EXACT.has(r.email)) {
      excluded.push(r.email);
      continue;
    }
    if (BAD_NAMES.test(r.firstName)) r.firstName = "";
    r.locale =
      LOCALE_OVERRIDE[r.email] ??
      (r.country === "DE" || r.country === "AT" ? "de" : r.country ? "nl" : DE_DOMAINS.test(r.email) ? "de" : "nl");
    recipients.push({ email: r.email, firstName: r.firstName, locale: r.locale, country: r.country });
  }
  recipients.sort((a, b) => a.locale.localeCompare(b.locale) || a.email.localeCompare(b.email));

  const sentLogPath = path.join(process.cwd(), "shutdown-mail-sent.json");
  const sentLog: Record<string, string> = fs.existsSync(sentLogPath)
    ? JSON.parse(fs.readFileSync(sentLogPath, "utf8"))
    : {};

  logger.info(`\n===== STOP-AANKONDIGING ${doSend ? "VERZENDEN" : "DRY-RUN"} =====`);
  logger.info(`Uitgesloten (${excluded.length}): ${excluded.join(", ")}`);
  logger.info(
    `Ontvangers: ${recipients.length} (nl ${recipients.filter((r) => r.locale === "nl").length}, de ${recipients.filter((r) => r.locale === "de").length}); al eerder verzonden: ${Object.keys(sentLog).length}`
  );
  for (const r of recipients) {
    logger.info(`  [${r.locale}] ${r.country || "?"} | ${r.firstName || "(geen naam)"} | ${r.email}${sentLog[r.email] ? " | AL VERZONDEN" : ""}`);
  }

  for (const loc of ["nl", "de"] as Locale[]) {
    const sample = recipients.find((r) => r.locale === loc && r.firstName) ?? { email: "x", firstName: "Voornaam", locale: loc, country: "" };
    const p = path.join(process.cwd(), `shutdown-preview-${loc}.html`);
    fs.writeFileSync(p, buildEmail(sample).html);
    logger.info(`Preview ${loc}: ${p}`);
  }

  if (!doSend) {
    logger.info("DRY-RUN, niets verzonden.");
    return;
  }

  let ok = 0, fail = 0, skip = 0;
  for (const r of recipients) {
    if (sentLog[r.email]) { skip++; continue; }
    const mail = buildEmail(r);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: r.email, reply_to: "info@gradepurity.com", subject: mail.subject, html: mail.html }),
      });
      const json: any = await res.json().catch(() => ({}));
      if (res.ok) {
        ok++;
        sentLog[r.email] = json.id ?? "ok";
        fs.writeFileSync(sentLogPath, JSON.stringify(sentLog, null, 2));
        logger.info(`VERZONDEN -> ${r.email} [${r.locale}] (id ${json.id})`);
        break;
      }
      if (res.status === 429 && attempt < 3) { await sleep(2000 * attempt); continue; }
      fail++;
      logger.error(`FOUT ${r.email}: ${res.status} ${JSON.stringify(json)}`);
      break;
    }
    await sleep(600);
  }
  logger.info(`\n===== KLAAR: ${ok} verzonden, ${fail} fout, ${skip} overgeslagen (al verzonden) =====`);
}
