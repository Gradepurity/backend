/**
 * Thin client voor de BANKpay+ API (bankpay.plus) + status-mapping.
 *
 * BANKpay+ is een A2A/open-banking rail (SEPA Instant, pay-by-bank): wij maken
 * een checkout aan, sturen de klant naar de hosted pagina, de klant betaalt
 * vanuit z'n eigen bank-app en het geld landt DIRECT op onze eigen IBAN
 * (geen tussenrekening — settlement-vertraging zoals bij Wallid >€250 bestaat
 * hier niet). Statussen zijn ISO 20022-codes uit de bankwereld.
 *
 * API-contract: aanmaken volgens hun officiële WooCommerce-plugin, status via
 * de live geverifieerde GET-route (27-07 tegen de echte API getest; de
 * `wc-status`-route uit de plugin bestaat niet meer):
 * - POST /api/checkout        (Bearer <privateKey>, form-encoded)
 *     -> { uuid, shortId, status: "created", redirectUrl }
 * - GET  /api/checkout/<uuid> (Bearer)
 *     -> { checkout: { uuid, correlationId, status, status_credited, ... },
 *          amount: { value, currency }, urls: {...} }
 * - Hosted betaalpagina:  https://bankpay.plus/checkout/<uuid>
 * - IPN: BANKpay+ pingt de door ons meegegeven `ipn`-URL; de status halen we
 *   daarna zelf authoritative op (zelfde patroon als de Wallid-provider).
 */

export type BankpayClientOptions = {
  /** Base URL, e.g. https://bankpay.plus */
  apiUrl: string
  /** Private API key uit het BANKpay+ dashboard (Developers -> API Keys). */
  privateKey: string
  /** CloudPOS instance UUID ("Gradepurity"). */
  clientId: string
}

export type BankpayCheckout = {
  uuid: string
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
  /** URL terug naar de checkout (bij afbreken). */
  checkoutUrl: string
}

/**
 * Betaald: de bank van de klant heeft de overboeking geaccepteerd/uitgevoerd.
 * ACSC/ACCC = settlement afgerond, ACSP = settlement onderweg (geld heeft de
 * bank van de klant verlaten), ACCP/ACTC/ACWC/ACWP = geaccepteerd na SCA
 * (uitvoering volgt; bij niet-instant banken kan settlement een dag duren,
 * maar de klant kan de betaling dan niet meer intrekken).
 */
const PAID_STATUSES = new Set([
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

  constructor(options: BankpayClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "")
    this.privateKey = options.privateKey
    this.clientId = options.clientId
  }

  /** De hosted betaalpagina voor een checkout. */
  checkoutPageUrl(checkoutUuid: string): string {
    return `${this.apiUrl}/checkout/${checkoutUuid}`
  }

  private async request<T>(
    path: string,
    init: { method: "GET" } | { method: "POST"; form: Record<string, string> }
  ): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: init.method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.privateKey}`,
        ...(init.method === "POST"
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
      },
      ...(init.method === "POST"
        ? { body: new URLSearchParams(init.form).toString() }
        : {}),
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
    const checkout = await this.request<BankpayCheckout>("/api/checkout", {
      method: "POST",
      form: {
        reference: params.reference,
        amount: params.amount,
        ipn: params.ipnUrl,
        correlationId: params.correlationId,
        clientId: this.clientId,
        returnUrl: params.returnUrl,
        checkoutUrl: params.checkoutUrl,
      },
    })
    if (!checkout?.uuid) {
      throw new Error(
        `BANKpay+ /api/checkout -> geen uuid in antwoord: ${JSON.stringify(checkout).slice(0, 200)}`
      )
    }
    return checkout
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
