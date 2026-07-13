import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  BigNumber,
  ContainerRegistrationKeys,
  PaymentActions,
} from "@medusajs/framework/utils"
import { processPaymentWorkflow } from "@medusajs/medusa/core-flows"
import { WallidClient } from "../../../../modules/wallid/lib/client"

/**
 * Wallid-webhook op het pad dat bij Wallid geregistreerd staat.
 *
 * WAAROM DEZE ROUTE BESTAAT: Medusa's ingebouwde webhook-route
 * (/hooks/payment/[provider]) plakt zelf `pp_` voor de provider uit de URL.
 * Wallid stuurt naar /hooks/payment/pp_card_wallid, dus Medusa zocht provider
 * `pp_pp_card_wallid` — die bestaat niet (AwilixResolutionError in de logs),
 * de fout werd ingeslikt en er kwam 200 terug zonder dat er iets gebeurde.
 * DAT was waarom "betaald maar geen order": de provider-webhookcode draaide
 * simpelweg nooit. Deze statische route vangt het bestaande pad af en draait
 * hetzelfde bewezen pad als /store/wallid/confirm (order #3).
 *
 * Beveiliging: HMAC wordt geverifieerd en gelogd, maar is niet de poort — de
 * AUTHORITATIVE getPayment-call bij Wallid bepaalt wat er gebeurt. Alleen een
 * payment die bij Wallid écht op SUCCESS staat (ongokbaar UUID) wordt verwerkt,
 * en processPaymentWorkflow is idempotent.
 */

type WallidWebhookEvent = {
  event_id?: string
  api_payment_id?: string
  order_id?: string
  status?: string
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  const apiUrl =
    process.env.WALLID_API_URL || "https://payment-api.wallid.co/api/payment-gw/v1"
  const keyId = process.env.WALLID_KEY_ID
  const keySecret = process.env.WALLID_KEY_SECRET
  const webhookSecret = process.env.WALLID_WEBHOOK_SECRET
  if (!keyId || !keySecret) {
    // 200: Wallid heeft geen retry-mechanisme dat we willen laten opstapelen.
    logger.error("[WALLID-HOOK] keys ontbreken — webhook genegeerd.")
    res.sendStatus(200)
    return
  }

  const client = new WallidClient({
    apiUrl,
    keyId,
    keySecret,
    webhookSecret: webhookSecret || "unused",
  })

  // HMAC: verifiëren + loggen (defense-in-depth). rawBody is beschikbaar via
  // de preserveRawBody-middleware; zonder rawBody loggen we dat expliciet.
  const ts = req.headers["x-webhook-timestamp"] as string | undefined
  const sig = req.headers["x-webhook-signature"] as string | undefined
  const raw = (req as MedusaRequest & { rawBody?: Buffer | string }).rawBody
  const rawStr =
    typeof raw === "string" ? raw : raw ? raw.toString("utf8") : JSON.stringify(req.body ?? {})
  const verified = webhookSecret
    ? client.verifyWebhookSignature(rawStr, ts, sig)
    : false
  logger.info(
    `[WALLID-HOOK] ontvangen op /hooks/payment/pp_card_wallid: signature ${
      verified ? "OK" : "FAALT"
    } (ts=${ts ?? "GEEN"}, rawBody=${raw ? "aanwezig" : "ONTBREEKT"})`
  )
  if (!verified) {
    // Strikte HMAC (terug sinds 13-07): echte Wallid-webhooks verifiëren
    // aantoonbaar met het prod-secret, dus een mismatch = niet van Wallid.
    // Vangnet blijft: de reconcile-cron rondt een gemiste betaling ≤3 min af.
    res.sendStatus(401)
    return
  }

  const events =
    ((req.body as { events?: WallidWebhookEvent[] })?.events ?? []).filter((e) =>
      ["SUCCESS", "FAILED", "EXPIRED"].includes(String(e.status))
    )
  if (!events.length) {
    res.sendStatus(200)
    return
  }

  for (const event of events) {
    const apiPaymentId = String(event.api_payment_id ?? "")
    if (!apiPaymentId) continue

    try {
      // Authoritative: status + order_id + bedrag server-side bij Wallid ophalen.
      const payment = await client.getPayment(apiPaymentId)
      // order_id = "<payment-session-id>~<suffix>" (zie service.buildOrderId).
      const sessionId = String(payment.order_id ?? "").split("~")[0]
      if (!sessionId.startsWith("payses_")) {
        logger.warn(
          `[WALLID-HOOK] payment ${apiPaymentId}: geen herleidbare sessie (order_id=${payment.order_id}).`
        )
        continue
      }

      const action =
        payment.status === "SUCCESS"
          ? PaymentActions.SUCCESSFUL
          : payment.status === "FAILED" || payment.status === "EXPIRED"
            ? PaymentActions.FAILED
            : null
      if (!action) {
        logger.info(
          `[WALLID-HOOK] payment ${apiPaymentId}: status ${payment.status} — niets te doen.`
        )
        continue
      }

      await processPaymentWorkflow(req.scope).run({
        input: {
          action,
          data: {
            session_id: sessionId,
            amount: new BigNumber(Number(payment.amount ?? 0) / 100),
          },
        },
      })
      logger.info(
        `[WALLID-HOOK] payment ${apiPaymentId} verwerkt (${payment.status} -> ${action}).`
      )
    } catch (e) {
      logger.error(
        `[WALLID-HOOK] verwerken van ${apiPaymentId} mislukt: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
  }

  res.sendStatus(200)
}
