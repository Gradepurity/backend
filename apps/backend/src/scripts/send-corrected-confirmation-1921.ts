import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { Resend } from "resend"
import { writeFileSync } from "fs"
import { resolve } from "path"
import { buildOrderEmailData } from "../lib/order-email"
import {
  renderLayout,
  renderOrderTable,
  renderAddress,
  money,
  UI,
} from "../modules/resend/templates/layout"

/**
 * Eenmalige, aangepaste orderbevestiging voor order #1921: de GHK-Cu-regel
 * (50 mg × 10) is per WhatsApp-afspraak vervangen door 100 mg × 5 betaald
 * + 100 mg × 2 gratis. Totalen blijven exact gelijk aan wat betaald is.
 *
 *   Dry-run (schrijft alleen preview-HTML, verstuurt niets):
 *     npx medusa exec ./src/scripts/send-corrected-confirmation-1921.ts
 *   Echt versturen naar de klant:
 *     npx medusa exec ./src/scripts/send-corrected-confirmation-1921.ts send
 */

const DISPLAY_ID = 1921
const PREVIEW_PATH = resolve(process.cwd(), "corrected-1921-preview.html")

export default async function sendCorrectedConfirmation({ container, args }: ExecArgs) {
  const logger = container.resolve("logger")
  const doSend = args?.[0] === "send"

  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["id", "display_id"],
    filters: { display_id: DISPLAY_ID } as any,
  })
  const orderId = orders?.[0]?.id
  if (!orderId) {
    logger.error(`[corrected-1921] order met display_id ${DISPLAY_ID} niet gevonden`)
    return
  }

  const payload = await buildOrderEmailData(container, orderId)
  if (!payload) {
    logger.error(`[corrected-1921] geen maildata voor ${orderId}`)
    return
  }

  // De order zelf is al omgebouwd naar 100 mg × 5 + × 2 gratis (order-edit
  // 24-07) en buildOrderEmailData voegt de cadeau-regels toe — as-is renderen.
  const items = payload.data.items.map((i) =>
    i.unit_price === 0 && /ghk/i.test(i.title ?? "") && i.subtitle === "100 mg vial"
      ? { ...i, subtitle: "100 mg vial, gratis extra" }
      : i
  )

  const lineSum =
    Math.round(items.reduce((s, i) => s + i.unit_price * i.quantity, 0) * 100) / 100
  if (lineSum !== payload.data.totals.total) {
    logger.error(
      `[corrected-1921] regelsom €${lineSum} wijkt af van ordertotaal €${payload.data.totals.total} — niet verstuurd`
    )
    return
  }

  const orderNo = `#${DISPLAY_ID}`
  const totals = payload.data.totals
  const currency = payload.data.currency_code
  const body = `
    <p style="margin:0 0 16px;">In overleg is je bestelling aangepast: je ontvangt 7 vials GHK-Cu van 100 mg, waarvan 2 gratis. Ook de gratis cadeaus bij je bestelling staan nu in het overzicht hieronder.</p>
    <div style="background:#F2F6EF;border:1px solid #D8E3CF;border-radius:6px;padding:16px 20px;margin:0 0 24px;">
      <span style="font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#3F6B2E;">&#10003; Betaling bevestigd</span><br/>
      <span style="font-family:Georgia,serif;font-size:20px;color:${UI.navy};">${orderNo} &mdash; ${money(totals.total, currency, "nl")}</span>
    </div>
    <h2 style="margin:0 0 4px;font-family:Georgia,serif;font-size:18px;font-weight:400;color:${UI.text};">Overzicht</h2>
    ${renderOrderTable(items, totals, currency, "nl")}
    ${
      payload.data.shipping_address
        ? `<h2 style="margin:24px 0 4px;font-family:Georgia,serif;font-size:18px;font-weight:400;color:${UI.text};">Verzendadres</h2>
           <p style="margin:0 0 24px;color:${UI.muted};line-height:1.6;">${renderAddress(payload.data.shipping_address)}</p>`
        : ""
    }
    <p style="margin:0;color:${UI.muted};">Vragen? Antwoord gerust op deze mail.</p>
  `
  const html = renderLayout(
    {
      preheader: `Bijgewerkt overzicht van je bestelling ${orderNo}.`,
      heading: "Je bijgewerkte bestelling",
      body,
    },
    "nl"
  )
  const subject = `Bijgewerkte orderbevestiging ${orderNo}`

  writeFileSync(PREVIEW_PATH, html, "utf8")
  logger.info(`[corrected-1921] preview geschreven naar ${PREVIEW_PATH}`)
  logger.info(`[corrected-1921] ontvanger: ${payload.email} — onderwerp: ${subject}`)

  if (!doSend) {
    logger.info(`[corrected-1921] dry-run, er is NIETS verstuurd. Versturen: zelfde commando met arg "send".`)
    return
  }

  const resend = new Resend(process.env.RESEND_API_KEY)
  const { data, error } = await resend.emails.send({
    from: process.env.RESEND_FROM!,
    to: [payload.email],
    subject,
    html,
    ...(process.env.RESEND_REPLY_TO ? { replyTo: process.env.RESEND_REPLY_TO } : {}),
  })
  if (error) {
    logger.error(`[corrected-1921] versturen mislukt: ${error.message}`)
    return
  }
  logger.info(`[corrected-1921] verstuurd naar ${payload.email} (id: ${data?.id})`)
}
