import { ExecArgs } from "@medusajs/framework/types"
import { Resend } from "resend"
import { writeFileSync } from "fs"
import { resolve } from "path"
import { renderLayout, UI } from "../modules/resend/templates/layout"

/**
 * Eenmalige mail voor de nazending bij order #1923 (Uschi Eggers): het
 * toegezegde bacteriostatisch water 10 ml is 31-07 als brievenbuspost
 * meegegaan met PostNL (3SSCMF8577237). Geen order-mutatie in Medusa.
 *
 *   Dry-run (schrijft alleen preview-HTML, verstuurt niets):
 *     npx medusa exec ./src/scripts/send-nazending-uschi.ts
 *   Echt versturen naar de klant:
 *     npx medusa exec ./src/scripts/send-nazending-uschi.ts send
 */

const TO = "uschie@live.nl"
const TRACKING = "3SSCMF8577237"
const TRACKING_URL = `https://jouw.postnl.nl/track-and-trace/${TRACKING}-NL-4907AS`
const PREVIEW_PATH = resolve(process.cwd(), "nazending-uschi-preview.html")

export default async function sendNazendingUschi({ container, args }: ExecArgs) {
  const logger = container.resolve("logger")
  const doSend = args?.[0] === "send"

  const body = `
    <p style="margin:0 0 16px;">Zoals per mail afgesproken sturen we je het bacteriostatisch water van 10 ml na. Het pakketje is vandaag meegegaan met PostNL en past door de brievenbus.</p>
    <div style="background:#F2F6EF;border:1px solid #D8E3CF;border-radius:6px;padding:16px 20px;margin:0 0 24px;">
      <span style="font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#3F6B2E;">&#10003; Nazending onderweg</span><br/>
      <span style="font-family:Georgia,serif;font-size:20px;color:${UI.navy};">Track &amp; trace: <a href="${TRACKING_URL}" style="color:${UI.navy};">${TRACKING}</a></span>
    </div>
    <p style="margin:0 0 24px;">Je kunt de zending volgen via <a href="${TRACKING_URL}" style="color:${UI.navy};">jouw.postnl.nl</a>.</p>
    <p style="margin:0;color:${UI.muted};">Vragen? Antwoord gerust op deze mail.</p>
  `
  const html = renderLayout(
    {
      preheader: "Je nazending is onderweg met PostNL.",
      heading: "Je nazending is onderweg",
      body,
    },
    "nl"
  )
  const subject = "Je nazending is onderweg"

  writeFileSync(PREVIEW_PATH, html, "utf8")
  logger.info(`[nazending-uschi] preview geschreven naar ${PREVIEW_PATH}`)
  logger.info(`[nazending-uschi] ontvanger: ${TO} — onderwerp: ${subject}`)

  if (!doSend) {
    logger.info(`[nazending-uschi] dry-run, er is NIETS verstuurd. Versturen: zelfde commando met arg "send".`)
    return
  }

  const resend = new Resend(process.env.RESEND_API_KEY)
  const { data, error } = await resend.emails.send({
    from: process.env.RESEND_FROM!,
    to: [TO],
    subject,
    html,
    ...(process.env.RESEND_REPLY_TO ? { replyTo: process.env.RESEND_REPLY_TO } : {}),
  })
  if (error) {
    logger.error(`[nazending-uschi] versturen mislukt: ${error.message}`)
    return
  }
  logger.info(`[nazending-uschi] verstuurd naar ${TO} (id: ${data?.id})`)
}
