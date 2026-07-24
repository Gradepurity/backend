import { ExecArgs } from "@medusajs/framework/types";
import { renderLayout, UI } from "../modules/resend/templates/layout";
import * as fs from "fs";
import * as path from "path";

/**
 * Herstel-mail naar klanten wier Wallid-betaling verliep vóór afronding
 * (geen order aangemaakt, dus buiten het bestaande payment-reminder-script om).
 * Pas RECIPIENTS aan per ronde. Verstuurt direct via de Resend API en schrijft
 * de verzonden HTML naar disk als preview.
 *   npx medusa exec ./src/scripts/send-checkout-recovery.ts           → dry-run (alleen preview)
 *   npx medusa exec ./src/scripts/send-checkout-recovery.ts send      → echt versturen
 *
 * Eerdere rondes: 21-07 (Anissa, Michiel) · 24-07 (Emre)
 */

const RECIPIENTS = [
  {
    email: "emre_2013@live.be",
    firstName: "Emre",
    items: "1× GHK-Cu en 1× Melanotan II",
    total: "€ 69,90",
    moment: "vannacht",
  },
];

function buildEmail(r: (typeof RECIPIENTS)[number]) {
  const body = `
<p style="margin:0 0 16px;">Hi ${r.firstName},</p>
<p style="margin:0 0 16px;">We zagen dat je ${r.moment} wilde afrekenen bij GradePurity (${r.items}, ${r.total}), maar dat de betaalpagina verliep voordat de betaling doorkwam. Dat lag niet aan jou &mdash; de betaalsessie sluit na 15 minuten vanzelf.</p>
<p style="margin:0 0 16px;">Je winkelwagen staat nog gewoon voor je klaar. Afronden duurt nog geen minuut:</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
  <tr><td style="background:${UI.navy};border-radius:8px;">
    <a href="https://gradepurity.com/nl/afrekenen" style="display:inline-block;padding:14px 28px;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;">Bestelling afronden &rarr;</a>
  </td></tr>
</table>
<p style="margin:0 0 8px;font-weight:700;">Reken je af op een computer?</p>
<p style="margin:0 0 16px;">Op de betaalpagina verschijnt een QR-code. Scan die met de gewone <strong>camera-app</strong> van je telefoon &mdash; niet met de QR-scanner in je bank-app. Via de camera opent de betaalpagina vanzelf op je telefoon en rond je de betaling daar af.</p>
<p style="margin:0;">Lukt het toch niet? Antwoord op deze mail of stuur een appje naar <a href="https://wa.me/31615605502" style="color:${UI.navy};">+31 6 15 60 55 02</a> &mdash; dan helpen we je direct verder.</p>`;

  return {
    subject: "Je betaling kwam niet door — je winkelwagen staat nog klaar",
    html: renderLayout(
      {
        preheader: `Je bestelling (${r.total}) staat nog klaar — afronden duurt nog geen minuut.`,
        heading: "Je bestelling stond al klaar.",
        body,
      },
      "nl"
    ),
  };
}

export default async function sendCheckoutRecovery({ container, args }: ExecArgs) {
  const logger = container.resolve("logger");
  const doSend = args?.[0] === "send";

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) {
    logger.error("RESEND_API_KEY / RESEND_FROM ontbreekt in env.");
    return;
  }

  for (const r of RECIPIENTS) {
    const mail = buildEmail(r);
    const previewPath = path.join(process.cwd(), `recovery-preview-${r.firstName.toLowerCase()}.html`);
    fs.writeFileSync(previewPath, mail.html);
    logger.info(`[recovery] preview: ${previewPath}`);

    if (!doSend) {
      logger.info(`[recovery] DRY-RUN — niet verzonden naar ${r.email}`);
      continue;
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: r.email,
        reply_to: "info@gradepurity.com",
        subject: mail.subject,
        html: mail.html,
      }),
    });
    const json: any = await res.json();
    if (res.ok) {
      logger.info(`[recovery] VERZONDEN -> ${r.email} (id ${json.id})`);
    } else {
      logger.error(`[recovery] FOUT voor ${r.email}: ${res.status} ${JSON.stringify(json)}`);
    }
  }
}
