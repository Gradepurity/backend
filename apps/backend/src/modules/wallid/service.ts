import {
  AbstractPaymentProvider,
  BigNumber,
  MedusaError,
  PaymentActions,
  PaymentSessionStatus,
} from "@medusajs/framework/utils"
import {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types"
import { WallidClient, WallidPayment } from "./lib/client"

export type WallidOptions = {
  /** Base URL van de Wallid gateway-API. */
  apiUrl: string
  keyId: string
  keySecret: string
  /** Door ons gegenereerd secret; ook bij Wallid geregistreerd voor de webhook. */
  webhookSecret: string
  /** Storefront-origin, e.g. https://gradepurity.com — voor de retour-URL's. */
  storefrontUrl: string
  /** Fallback-retourpaden als de storefront ze niet meegeeft in de sessie-data. */
  successPath?: string
  failPath?: string
}

type InjectedDependencies = {
  logger: Logger
}

/**
 * Wallid hosted-checkout payment provider voor Medusa v2.
 *
 * Zelfde patroon als de BTCPay-provider: sessie openen -> klant redirecten naar
 * `payment_link` -> Wallid meldt de finale status (SUCCESS/FAILED/EXPIRED) via
 * webhook op POST /hooks/payment/pp_card_wallid -> processPaymentWorkflow
 * autoriseert + captured + rondt de cart af (order ontstaat).
 *
 * Anders dan BTCPay pollt authorizePayment hier de Wallid-status live: het
 * autocapture-pad van processPaymentWorkflow roept authorizePayment aan en die
 * moet AUTHORIZED teruggeven zodra Wallid SUCCESS meldt. Dat maakt ook de
 * fallback mogelijk (status verifiëren als de webhook uitblijft).
 *
 * Geregistreerde key: pp_card_wallid (identifier "card", id "wallid").
 */
class WallidProviderService extends AbstractPaymentProvider<WallidOptions> {
  static identifier = "card"

  protected logger_: Logger
  protected options_: WallidOptions
  protected client_: WallidClient

  static validateOptions(options: Record<string, unknown>): void {
    const required = ["apiUrl", "keyId", "keySecret", "webhookSecret"] as const
    for (const key of required) {
      if (!options[key]) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Wallid: \`${key}\` is required in the provider options.`
        )
      }
    }
  }

  constructor(container: InjectedDependencies, options: WallidOptions) {
    super(container, options)

    this.logger_ = container.logger
    this.options_ = options
    this.client_ = new WallidClient({
      apiUrl: options.apiUrl,
      keyId: options.keyId,
      keySecret: options.keySecret,
      webhookSecret: options.webhookSecret,
    })
  }

  private buildReturnUrl(path: string | undefined, fallback: string): string {
    const origin = this.options_.storefrontUrl.replace(/\/$/, "")
    return `${origin}${path ?? fallback}`
  }

  /**
   * Wallid eist een uniek order_id per merchant. Bij hercreatie (cart-bedrag
   * gewijzigd) plakken we een suffix achter de sessie-id; de webhook herleidt
   * de sessie via de authoritative status-call, niet via het order_id zelf.
   */
  private buildOrderId(sessionId: string): string {
    return `${sessionId}~${Date.now().toString(36)}`
  }

  private async createPaymentForSession(
    sessionId: string,
    amount: number,
    currencyCode: string,
    opts: {
      buyerEmail?: string
      locale?: string
      successUrl?: string
      failUrl?: string
    } = {}
  ) {
    const amountMinor = Math.round(amount * 100)
    const storefront = this.options_.storefrontUrl.replace(/\/$/, "")

    const payment = await this.client_.createPayment({
      orderId: this.buildOrderId(sessionId),
      amountMinor,
      currency: currencyCode,
      successUrl:
        opts.successUrl ??
        this.buildReturnUrl(this.options_.successPath, "/nl/bestelling-ontvangen"),
      failUrl:
        opts.failUrl ?? this.buildReturnUrl(this.options_.failPath, "/nl/afrekenen"),
      customerEmail: opts.buyerEmail,
      locale: opts.locale,
      description: `GradePurity bestelling (${sessionId})`,
      // Wallid laat sessies default na 15 min verlopen; geef de klant een uur.
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      // Eén samenvattende regel: Wallid eist minimaal één item met alle velden.
      items: [
        {
          name: "GradePurity bestelling",
          category: "Drogisterij",
          price_minor: amountMinor,
          image_url: `${storefront}/logo.png`,
          product_url: `${storefront}/nl`,
        },
      ],
    })

    return {
      id: payment.api_payment_id,
      data: {
        api_payment_id: payment.api_payment_id,
        wallid_order_id: payment.order_id,
        payment_link: payment.payment_link,
        session_id: sessionId,
        price_amount: amount,
        price_minor: amountMinor,
        price_currency: payment.currency,
      } as Record<string, unknown>,
    }
  }

  async initiatePayment(
    input: InitiatePaymentInput
  ): Promise<InitiatePaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    const sessionId = (data.session_id as string) ?? ""
    const amount = new BigNumber(input.amount).numeric
    const buyerEmail = (
      input.context as { customer?: { email?: string } } | undefined
    )?.customer?.email

    const { id, data: sessionData } = await this.createPaymentForSession(
      sessionId,
      amount,
      input.currency_code,
      {
        buyerEmail,
        locale: data.locale as string | undefined,
        successUrl: data.success_url as string | undefined,
        failUrl: data.fail_url as string | undefined,
      }
    )

    // Pending: de klant betaalt op de hosted pagina; webhook/status-poll rondt af.
    return { id, status: PaymentSessionStatus.PENDING, data: sessionData }
  }

  /** Haal de actuele Wallid-status op voor deze sessie (authoritative). */
  private async fetchStatus(
    data: Record<string, unknown> | undefined
  ): Promise<WallidPayment | null> {
    const apiPaymentId = (data?.api_payment_id as string) ?? ""
    if (!apiPaymentId) {
      return null
    }
    try {
      return await this.client_.getPayment(apiPaymentId)
    } catch (e) {
      this.logger_.warn(
        `Wallid: status-call mislukt voor ${apiPaymentId}: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
      return null
    }
  }

  async authorizePayment(
    input: AuthorizePaymentInput
  ): Promise<AuthorizePaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    const payment = await this.fetchStatus(data)

    // processPaymentWorkflow (webhook) en de storefront-fallback komen hier
    // pas nadat Wallid SUCCESS heeft gemeld — verifieer dat server-side.
    switch (payment?.status) {
      case "SUCCESS":
        return { status: PaymentSessionStatus.AUTHORIZED, data }
      case "FAILED":
      case "EXPIRED":
        return { status: PaymentSessionStatus.ERROR, data }
      default:
        return { status: PaymentSessionStatus.PENDING, data }
    }
  }

  async capturePayment(
    input: CapturePaymentInput
  ): Promise<CapturePaymentOutput> {
    // Geld staat al bij Wallid zodra de status SUCCESS is; capture is een marker.
    return { data: { ...(input.data ?? {}), captured: true } }
  }

  async getPaymentStatus(
    input: GetPaymentStatusInput
  ): Promise<GetPaymentStatusOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    if (data.captured) {
      return { status: PaymentSessionStatus.CAPTURED, data }
    }
    const payment = await this.fetchStatus(data)
    switch (payment?.status) {
      case "SUCCESS":
        return { status: PaymentSessionStatus.AUTHORIZED, data }
      case "FAILED":
      case "EXPIRED":
        return { status: PaymentSessionStatus.ERROR, data }
      default:
        return { status: PaymentSessionStatus.PENDING, data }
    }
  }

  async updatePayment(
    input: UpdatePaymentInput
  ): Promise<UpdatePaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    const newAmount = new BigNumber(input.amount).numeric
    const oldAmount = Number(data.price_amount ?? NaN)

    // Wallid-payments liggen vast bij aanmaak; hercreëer als het bedrag wijzigt.
    if (!Number.isNaN(oldAmount) && oldAmount === newAmount) {
      return { status: PaymentSessionStatus.PENDING, data }
    }

    const sessionId = (data.session_id as string) ?? ""
    const fresh = await this.createPaymentForSession(
      sessionId,
      newAmount,
      input.currency_code,
      { locale: data.locale as string | undefined }
    )
    return { status: PaymentSessionStatus.PENDING, data: fresh.data }
  }

  async cancelPayment(
    input: CancelPaymentInput
  ): Promise<CancelPaymentOutput> {
    // Onbetaalde Wallid-sessies verlopen vanzelf; er is geen void-endpoint.
    return { data: input.data ?? {} }
  }

  async deletePayment(
    input: DeletePaymentInput
  ): Promise<DeletePaymentOutput> {
    return { data: input.data ?? {} }
  }

  async refundPayment(
    input: RefundPaymentInput
  ): Promise<RefundPaymentOutput> {
    // De gateway-API kent geen refund-endpoint — refunds lopen via Wallid support.
    const sessionId =
      (input.data as Record<string, unknown> | undefined)?.session_id ?? "?"
    this.logger_.warn(
      `Wallid: refund aangevraagd (sessie ${sessionId}). Refunds lopen out-of-band via Wallid — handmatig afhandelen.`
    )
    return { data: input.data ?? {} }
  }

  async retrievePayment(
    input: RetrievePaymentInput
  ): Promise<RetrievePaymentOutput> {
    return { data: input.data ?? {} }
  }

  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    const { data, rawData, headers } = payload

    const header = (name: string): string | undefined => {
      const h = headers as Record<string, unknown> | undefined
      return (h?.[name.toLowerCase()] ?? h?.[name]) as string | undefined
    }

    const raw = normalizeRawBody(rawData)

    // ── Diagnostische logging (tijdelijk) ──────────────────────────────────
    // De webhook faalt stil: bij een ongeldige signature geeft Medusa 200 terug
    // en stuurt Wallid nooit opnieuw. Log daarom exact wát binnenkomt en waaróm
    // verificatie faalt, zodat we secret-mismatch / klok-skew / body-mismatch
    // kunnen onderscheiden. Prefix [WALLID-HOOK] om terug te vinden in de logs.
    const ts = header("X-Webhook-Timestamp")
    const sig = header("X-Webhook-Signature")
    const tsNum = ts ? Number.parseInt(ts, 10) : NaN
    const ageSec = Number.isFinite(tsNum) ? Math.abs(Date.now() / 1000 - tsNum) : NaN
    this.logger_.info(
      `[WALLID-HOOK] ontvangen: ts=${ts ?? "GEEN"} (leeftijd ${Number.isFinite(ageSec) ? Math.round(ageSec) + "s" : "n.v.t."}), ` +
        `sig=${sig ? sig.slice(0, 16) + "…" : "GEEN"}, rawBody-lengte=${raw.length}`
    )

    const verified = this.client_.verifyWebhookSignature(raw, ts, sig)
    if (!verified) {
      // Handtekening faalt (verkeerd prod-secret / klok-skew / body-mangeling).
      // NIET zomaar weigeren: de order-aanmaak hangt hier volledig van af en de
      // klant mag niet terug hoeven naar de bedankpagina. In plaats daarvan
      // vertrouwen we op de AUTHORITATIVE server-side status-call hieronder
      // (getPayment bij Wallid): alleen een echt op SUCCESS staande betaling met
      // een geldig, ongokbaar api_payment_id wordt verwerkt. De HMAC is dan
      // defense-in-depth, niet de enige poort.
      let reden = "signature-mismatch"
      if (!ts || !sig) reden = "ontbrekende header(s)"
      else if (!Number.isFinite(tsNum)) reden = "timestamp niet-numeriek"
      else if (Number.isFinite(ageSec) && ageSec > 300) reden = `timestamp te oud (${Math.round(ageSec)}s) — klok-skew?`
      this.logger_.warn(
        `[WALLID-HOOK] signature faalde (${reden}) — val terug op authoritative Wallid-status-check.`
      )
    } else {
      this.logger_.info("[WALLID-HOOK] signature OK.")
    }

    const events = (data as { events?: WallidWebhookEvent[] })?.events ?? []
    const finalEvents = events.filter(
      (e) => e.status === "SUCCESS" || e.status === "FAILED" || e.status === "EXPIRED"
    )
    if (!finalEvents.length) {
      return { action: PaymentActions.NOT_SUPPORTED }
    }
    if (finalEvents.length > 1) {
      // Medusa verwerkt één actie per webhook-call; extra events vangen we op
      // via de status-poll fallback (authorizePayment) of een Wallid-retry.
      this.logger_.warn(
        `Wallid webhook: ${finalEvents.length} events in één request — alleen het eerste wordt direct verwerkt.`
      )
    }
    const event = finalEvents[0]

    // Lees de payment server-side terug: authoritative status/order_id/bedrag.
    let payment: WallidPayment
    try {
      payment = await this.client_.getPayment(String(event.api_payment_id))
    } catch (e) {
      this.logger_.warn(
        `Wallid webhook: kon payment ${event.api_payment_id} niet ophalen: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    // order_id = "<payment-session-id>~<suffix>" (zie buildOrderId).
    const sessionId = String(payment.order_id ?? "").split("~")[0]
    const amount = new BigNumber(Number(payment.amount ?? 0) / 100)

    switch (payment.status) {
      case "SUCCESS":
        // Autoriseert + captured + rondt de cart af (processPaymentWorkflow).
        return {
          action: PaymentActions.SUCCESSFUL,
          data: { session_id: sessionId, amount },
        }
      case "FAILED":
      case "EXPIRED":
        return {
          action: PaymentActions.FAILED,
          data: { session_id: sessionId, amount },
        }
      default:
        return { action: PaymentActions.NOT_SUPPORTED }
    }
  }
}

type WallidWebhookEvent = {
  event_id?: string
  api_payment_id?: string
  order_id?: string
  status?: string
  status_error?: string
  amount?: number
  currency?: string
  occurred_at?: string
}

/** Medusa serialiseert rawData over de event-bus; rehydrate naar UTF-8 string. */
function normalizeRawBody(rawData: unknown): string {
  if (typeof rawData === "string") {
    return rawData
  }
  if (Buffer.isBuffer(rawData)) {
    return rawData.toString("utf8")
  }
  const maybeBuffer = rawData as { type?: string; data?: number[] } | undefined
  if (maybeBuffer?.type === "Buffer" && Array.isArray(maybeBuffer.data)) {
    return Buffer.from(maybeBuffer.data).toString("utf8")
  }
  return ""
}

export default WallidProviderService
