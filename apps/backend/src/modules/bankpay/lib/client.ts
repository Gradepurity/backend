/**
 * Thin client voor de BANKpay+ API (bankpay.plus) + status-mapping.
 *
 * BANKpay+ is een A2A/open-banking rail (SEPA Instant, pay-by-bank): wij maken
 * een checkout aan, sturen de klant naar de hosted pagina, de klant betaalt
 * vanuit z'n eigen bank-app en het geld landt DIRECT op onze eigen IBAN
 * (geen tussenrekening — settlement-vertraging zoals bij Wallid >€250 bestaat
 * hier niet). Statussen zijn ISO 20022-codes uit de bankwereld.
 *
 * API-contract, volledig live geverifieerd 27/28-07 tegen de echte API:
 * - POST /api/v1/checkouts (Bearer, JSON, Idempotency-Key-header verplicht)
 *     velden: amount, currency, reference+description, recipient_iban,
 *     recipient_name, correlation_id, return_url, webhook_url (= IPN)
 *     -> { success, data: { checkout_id, checkout_url, ... } }
 *   De oude plugin-route POST /api/checkout werkt óók maar NEGEERT
 *   returnUrl/checkoutUrl en koppelt de ontvanger (naam/IBAN) NIET — de
 *   klant zag dan een betaling zonder begunstigde in z'n bank-app.
 * - GET  /api/checkout/<uuid> (Bearer)
 *     -> { checkout: { uuid, correlationId, status, status_credited, ... },
 *          amount: { value }, urls: { return, ipn } }
 * - Hosted betaalpagina:  https://bankpay.plus/checkout/<uuid>
 * - IPN: BANKpay+ pingt de webhook_url; de status halen we daarna zelf
 *   authoritative op (zelfde patroon als de Wallid-provider).
 */

export type BankpayClientOptions = {
  /** Base URL, e.g. https://bankpay.plus */
  apiUrl: string
  /** Private API key uit het BANKpay+ dashboard (Developers -> API Keys). */
  privateKey: string
  /** CloudPOS instance UUID ("Gradepurity"). */
  clientId: string
  /** Begunstigde van de overboeking — verplicht voor createCheckout (v1-route);
   *  status-only gebruik (IPN/confirm/reconcile) mag ze weglaten. */
  recipientIban?: string
  recipientName?: string
}

export type BankpayCheckout = {
  uuid: string
  /** Hosted betaalpagina — de API geeft 'm zelf terug (redirectUrl/checkout_url). */
  redirectUrl?: string
  checkout_url?: string
  [key: string]: unknown
}

export type BankpayStatus = {
  uuid?: string
  correlationId?: string
  /** Checkout-status: ISO 20022-code of BANKpay+-woord (created, paid, …). */
  payment?: string
  /** `status_credited` uit de API — gezet zodra het geld gecrediteerd is. */
  credited?: string | null
  [key: string]: unknown
}

export type CreateCheckoutParams = {
  /** Omschrijving op de overschrijving van de klant. */
  reference: string
  /** Bedrag in euro's als decimaal (bv. "479.85") — GEEN minor units. */
  amount: string
  /** Onze webhook-URL die BANKpay+ na de betaling pingt. */
  ipnUrl: string
  /** Onze koppel-sleutel — wij gebruiken de Medusa payment-session-id. */
  correlationId: string
  /** URL waar de klant na betalen landt. */
  returnUrl: string
  /** Verplichte Idempotency-Key: zelfde key = zelfde checkout bij retries. */
  idempotencyKey: string
}

/**
 * Betaald: de bank van de klant heeft de overboeking geaccepteerd/uitgevoerd.
 * ACSC/ACCC = settlement afgerond, ACSP = settlement onderweg (geld heeft de
 * bank van de klant verlaten), ACCP/ACTC/ACWC/ACWP = geaccepteerd na SCA
 * (uitvoering volgt; bij niet-instant banken kan settlement een dag duren,
 * maar de klant kan de betaling dan niet meer intrekken).
 *
 * RCVD hoort er óók bij: live vastgesteld 28-07 dat een daadwerkelijk
 * betaalde checkout (geld aantoonbaar op Finom) bij BANKpay+ als eindstatus
 * RCVD houdt — hun platform pollt de bank daarna niet verder. RCVD wordt pas
 * gezet nadat de bank de opdracht na SCA heeft aangenomen; onbetaalde
 * checkouts blijven op created/pending staan.
 */
const PAID_STATUSES = new Set([
  "RCVD",
  "ACCC",
  "ACCP",
  "ACSC",
  "ACSP",
  "ACTC",
  "ACWC",
  "ACWP",
  "Accepted",
  "AcceptedSettlementCompleted",
  "AcceptedSettlementInProcess",
  "AcceptedWithChange",
  "AcceptedWithoutPosting",
  "AcceptedTechnicalValidation",
  "AcceptedCustomerProfile",
  "AcceptedFundsChecked",
])

const FAILED_STATUSES = new Set([
  "RJCT",
  "Rejected",
  "Cancelled",
  "PaymentCancelled",
])

export type MappedStatus = "paid" | "failed" | "pending"

// BANKpay+ gebruikt naast ISO-codes ook gewone woorden (dashboard toont
// "Pending"/"Successful"); vang beide vocabulaires af.
const PAID_WORDS = new Set(["paid", "success", "successful", "completed", "credited", "settled"])
const FAILED_WORDS = new Set(["failed", "rejected", "cancelled", "canceled", "expired", "error"])

/** Map een BANKpay+-statusrespons naar ons interne drieluik. */
export function mapBankpayStatus(status: BankpayStatus): MappedStatus {
  // `status_credited` gezet = geld gecrediteerd, ongeacht de statustekst.
  if (status.credited) {
    return "paid"
  }

  const code = status.payment
  if (!code) {
    return "pending"
  }
  // Cancellation-request-flow (AcceptedCancellationRequest e.d.) is nooit
  // "betaald", ook al begint de code met "Accepted".
  if (code.includes("Cancellation")) {
    return code.startsWith("Rejected") ? "failed" : "pending"
  }
  if (PAID_STATUSES.has(code) || PAID_WORDS.has(code.toLowerCase())) {
    return "paid"
  }
  if (FAILED_STATUSES.has(code) || FAILED_WORDS.has(code.toLowerCase())) {
    return "failed"
  }
  // created / SCArequired / RCVD / PDNG / UNKN / ...
  return "pending"
}

export class BankpayClient {
  private readonly apiUrl: string
  private readonly privateKey: string
  readonly clientId: string
  private readonly recipientIban: string
  private readonly recipientName: string

  constructor(options: BankpayClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "")
    this.privateKey = options.privateKey
    this.clientId = options.clientId
    this.recipientIban = options.recipientIban ?? ""
    this.recipientName = options.recipientName ?? ""
  }

  /** De hosted betaalpagina voor een checkout. */
  checkoutPageUrl(checkoutUuid: string): string {
    return `${this.apiUrl}/checkout/${checkoutUuid}`
  }

  private async request<T>(
    path: string,
    init:
      | { method: "GET" }
      | { method: "POST"; json: Record<string, unknown>; idempotencyKey: string }
  ): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: init.method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.privateKey}`,
        ...(init.method === "POST"
          ? {
              "Content-Type": "application/json",
              "Idempotency-Key": init.idempotencyKey,
            }
          : {}),
      },
      ...(init.method === "POST" ? { body: JSON.stringify(init.json) } : {}),
    })

    const text = await res.text()
    if (!res.ok) {
      throw new Error(
        `BANKpay+ ${path} -> HTTP ${res.status}: ${text.slice(0, 300) || res.statusText}`
      )
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(`BANKpay+ ${path} -> onleesbaar antwoord: ${text.slice(0, 200)}`)
    }
  }

  async createCheckout(params: CreateCheckoutParams): Promise<BankpayCheckout> {
    if (!this.recipientIban || !this.recipientName) {
      throw new Error("BANKpay+: recipientIban/recipientName ontbreken voor createCheckout.")
    }
    const res = await this.request<{
      success?: boolean
      data?: { checkout_id?: string; checkout_url?: string }
      error?: { code?: string; message?: string }
    }>("/api/v1/checkouts", {
      method: "POST",
      idempotencyKey: params.idempotencyKey,
      json: {
        amount: params.amount,
        currency: "EUR",
        reference: params.reference,
        description: params.reference,
        recipient_iban: this.recipientIban,
        recipient_name: this.recipientName,
        correlation_id: params.correlationId,
        return_url: params.returnUrl,
        webhook_url: params.ipnUrl,
      },
    })

    const uuid = res.data?.checkout_id
    if (!res.success || !uuid) {
      throw new Error(
        `BANKpay+ /api/v1/checkouts -> geen checkout_id: ${JSON.stringify(res).slice(0, 200)}`
      )
    }
    return {
      uuid,
      redirectUrl: res.data?.checkout_url,
    }
  }

  /** Actuele status van een checkout (authoritative). */
  async getStatus(checkoutUuid: string): Promise<BankpayStatus> {
    const raw = await this.request<{
      checkout?: {
        uuid?: string
        correlationId?: string
        status?: string
        status_credited?: string | null
      }
      amount?: { value?: number; currency?: string }
    }>(`/api/checkout/${encodeURIComponent(checkoutUuid)}`, { method: "GET" })

    return {
      uuid: raw.checkout?.uuid,
      correlationId: raw.checkout?.correlationId,
      payment: raw.checkout?.status,
      credited: raw.checkout?.status_credited ?? null,
      amount: raw.amount?.value,
    }
  }
}
