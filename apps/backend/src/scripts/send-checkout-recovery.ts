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
 * Eerdere rondes: 21-07 (Anissa, Michiel) · 24-07 (Emre, Kaw) · 27-07 (Mike)
 */

const RECIPIENTS = [
  {
    email: "tdraw33@gmail.com",
    firstName: "Mike",
    items: "1× PT-141 10 mg, 1× insulinenaalden 10× 1ml",
    total: "€ 46,85",
    reference: "Mike Rozenblad",
  },
];

function buildEmail(r: (typeof RECIPIENTS)[number]) {
  const body = `
<p style="margin:0 0 24px;">Hi ${r.firstName},</p>

<p style="margin:0 0 24px;">Je betaling kwam vandaag niet door. Je kunt je bestelling (${r.items} &mdash; ${r.total} incl. verzending) gewoon per overboeking betalen:</p>

<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px;background:#F5F3EE;border-radius:8px;">
  <tr><td style="padding:24px 28px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:2;color:#1A1A1A;">
    <strong>Bedrag:</strong>&nbsp; ${r.total}<br/>
    <strong>Rekening:</strong>&nbsp; NL81 FNOM 0779 1759 17<br/>
    <strong>T.n.v.:</strong>&nbsp; Gradepurity<br/>
    <strong>Omschrijving:</strong>&nbsp; ${r.reference}
  </td></tr>
</table>

<p style="margin:0 0 24px;">Zodra de betaling binnen is, versturen wij je bestelling direct.</p>

<p style="margin:0;">Vragen? Antwoord op deze mail of stuur een appje naar <a href="https://wa.me/31615605502" style="color:${UI.navy};">+31 6 15 60 55 02</a>.</p>`;

  return {
    subject: "Rond je bestelling af — betaal per overboeking",
    html: renderLayout(
      {
        preheader: `Je bestelling (${r.total}) kun je per overboeking betalen.`,
        heading: "Rond je bestelling af.",
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
