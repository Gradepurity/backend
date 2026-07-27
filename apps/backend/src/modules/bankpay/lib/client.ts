/**
 * Thin client voor de BANKpay+ API (bankpay.plus) + status-mapping.
 *
 * BANKpay+ is een A2A/open-banking rail (SEPA Instant, pay-by-bank): wij maken
 * een checkout aan, sturen de klant naar de hosted pagina, de klant betaalt
 * vanuit z'n eigen bank-app en het geld landt DIRECT op onze eigen IBAN
 * (geen tussenrekening — settlement-vertraging zoals bij Wallid >€250 bestaat
 * hier niet). Statussen zijn ISO 20022-codes uit de bankwereld.
 *
 * API-contract gereverse-engineerd uit hun officiële WooCommerce-plugin
 * (wordpress.org: bankpay-open-banking-sepa-payments-for-woocommerce):
 * - POST /api/checkout   (Bearer <privateKey>, form-encoded) -> { uuid }
 * - POST /api/wc-status/ (form-encoded: checkout=<uuid>)     -> { uuid, correlationId, payment, paymentId }
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
  /** ISO 20022 status, bv. ACSC, ACSP, RJCT, created, SCArequired. */
  payment?: string
  paymentId?: string
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

/** Map een ISO 20022 / BANKpay+-status naar ons interne drieluik. */
export function mapBankpayStatus(status: string | undefined): MappedStatus {
  if (!status) {
    return "pending"
  }
  // Cancellation-request-flow (AcceptedCancellationRequest e.d.) is nooit
  // "betaald", ook al begint de code met "Accepted".
  if (status.includes("Cancellation")) {
    return FAILED_STATUSES.has(status) || status.startsWith("Rejected")
      ? "failed"
      : "pending"
  }
  if (PAID_STATUSES.has(status)) {
    return "paid"
  }
  if (FAILED_STATUSES.has(status)) {
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

  private async post<T>(
    path: string,
    body: Record<string, string>,
    withAuth: boolean
  ): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        ...(withAuth ? { Authorization: `Bearer ${this.privateKey}` } : {}),
      },
      body: new URLSearchParams(body).toString(),
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
    const checkout = await this.post<BankpayCheckout>(
      "/api/checkout",
      {
        reference: params.reference,
        amount: params.amount,
        ipn: params.ipnUrl,
        correlationId: params.correlationId,
        clientId: this.clientId,
        returnUrl: params.returnUrl,
        checkoutUrl: params.checkoutUrl,
      },
      true
    )
    if (!checkout?.uuid) {
      throw new Error(
        `BANKpay+ /api/checkout -> geen uuid in antwoord: ${JSON.stringify(checkout).slice(0, 200)}`
      )
    }
    return checkout
  }

  /**
   * Actuele status van een checkout (authoritative). De plugin-endpoint
   * `wc-status/` werkt zonder auth-header; we sturen 'm toch mee voor het
   * geval ze dat aanscherpen.
   */
  getStatus(checkoutUuid: string): Promise<BankpayStatus> {
    return this.post<BankpayStatus>(
      "/api/wc-status/",
      { checkout: checkoutUuid, client: this.clientId },
      true
    )
  }
}
