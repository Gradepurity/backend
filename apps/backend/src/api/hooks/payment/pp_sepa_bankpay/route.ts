import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  ContainerRegistrationKeys,
  PaymentActions,
} from "@medusajs/framework/utils"
import { processPaymentWorkflow } from "@medusajs/medusa/core-flows"
import { BankpayClient, mapBankpayStatus } from "../../../../modules/bankpay/lib/client"

/**
 * BANKpay+ IPN-route. Wij geven bij het aanmaken van de checkout een `ipn`-URL
 * mee met onze eigen session_id als query-param; BANKpay+ pingt die URL na de
 * betaling (mogelijk met extra params zoals checkoutId).
 *
 * Beveiliging: de IPN heeft geen signature. De ping is daarom NIET de bron van
 * waarheid — we lezen de sessie uit onze eigen DB, halen de status
 * authoritative op bij BANKpay+ (wc-status met het checkout-uuid uit ónze
 * sessie-data, niet uit de request) en pas een écht op betaald staande
 * checkout wordt verwerkt. processPaymentWorkflow is idempotent.
 *
 * Statische route om dezelfde reden als bij Wallid: Medusa's ingebouwde
 * /hooks/payment/[provider]-route plakt zelf `pp_` voor de provider-naam.
 */

async function handleIpn(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  const privateKey = process.env.BANKPAY_API_KEY
  const clientId = process.env.BANKPAY_CLIENT_ID
  if (!privateKey || !clientId) {
    logger.error("[BANKPAY-IPN] keys ontbreken — ping genegeerd.")
    res.sendStatus(200)
    return
  }

  // Twee aanvoerroutes: (1) de per-checkout webhook_url met onze eigen
  // ?session_id=… query, (2) de globale developer-webhook (payment.completed
  // e.d.) die de identifiers in de BODY meestuurt. Vang beide af; de body is
  // onvertrouwd en dient alleen om de sessie te vinden — de authoritative
  // status-check hieronder blijft de poort. (Signing-secret whsec_… staat in
  // BANKPAY_WEBHOOK_SECRET voor als hun signature-scheme gedocumenteerd raakt.)
  const body = (req.body ?? {}) as Record<string, unknown>
  const bodyData = (body.data ?? body.payload ?? body.checkout ?? {}) as Record<
    string,
    unknown
  >
  const fromBody = (key: string): string | undefined => {
    const v = bodyData[key] ?? body[key]
    return typeof v === "string" && v ? v : undefined
  }

  const sessionId = String(
    (req.query.session_id as string | undefined) ??
      (req.query.correlationId as string | undefined) ??
      fromBody("correlation_id") ??
      fromBody("correlationId") ??
      ""
  )
  if (!sessionId.startsWith("payses_")) {
    logger.warn(
      `[BANKPAY-IPN] geen bruikbare session_id in ping (query=${JSON.stringify(req.query)}, body-keys=${Object.keys(body).join(",") || "geen"}).`
    )
    res.sendStatus(200)
    return
  }

  const client = new BankpayClient({
    apiUrl: process.env.BANKPAY_API_URL || "https://bankpay.plus",
    privateKey,
    clientId,
  })

  try {
    // Sessie uit onze eigen DB — het checkout-uuid komt uit onze data, zodat
    // een aanvaller met een geldig sessie-id geen vreemde checkout kan koppelen.
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data: sessions } = await query.graph({
      entity: "payment_session",
      fields: ["id", "status", "data", "amount"],
      filters: { id: sessionId, provider_id: "pp_sepa_bankpay" },
    })
    const session = sessions?.[0]
    const checkoutUuid = (session?.data as { checkout_uuid?: string } | undefined)
      ?.checkout_uuid
    if (!session || !checkoutUuid) {
      logger.warn(`[BANKPAY-IPN] sessie ${sessionId} niet gevonden of zonder checkout.`)
      res.sendStatus(200)
      return
    }

    const status = await client.getStatus(checkoutUuid)
    const mapped = mapBankpayStatus(status)
    logger.info(
      `[BANKPAY-IPN] sessie ${sessionId}: checkout ${checkoutUuid} status ${status.payment} -> ${mapped}.`
    )

    if (mapped === "pending") {
      res.sendStatus(200)
      return
    }

    await processPaymentWorkflow(req.scope).run({
      input: {
        action:
          mapped === "paid" ? PaymentActions.SUCCESSFUL : PaymentActions.FAILED,
        data: {
          session_id: sessionId,
          amount: session.amount,
        },
      },
    })
    logger.info(`[BANKPAY-IPN] sessie ${sessionId} verwerkt (${mapped}).`)
  } catch (e) {
    logger.error(
      `[BANKPAY-IPN] verwerken van ${sessionId} mislukt: ${
        e instanceof Error ? e.message : String(e)
      }`
    )
  }

  res.sendStatus(200)
}

// BANKpay+ documenteert de IPN-methode niet; vang zowel POST als GET af.
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await handleIpn(req, res)
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await handleIpn(req, res)
}
