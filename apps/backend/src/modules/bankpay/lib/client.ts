/**
 * Thin client voor de BANKpay+ API (bankpay.plus) + status-mapping.
 *
 * BANKpay+ is een A2A/open-banking rail (SEPA Instant, pay-by-bank): wij maken
 * een checkout aan, sturen de klant naar de hosted pagina, de klant betaalt
 * vanuit z'n eigen bank-app en het geld landt DIRECT op onze eigen IBAN
 * (geen tussenrekening — settlement-vertraging zoals bij Wallid >€250 bestaat
 * hier niet). Statussen zijn ISO 20022-codes uit de bankwereld.
 *
 * API-contract, volledig live geverifieerd 29-07 tegen de echte API:
 * - POST /api/checkout (Bearer, JSON) — de route die de officiële
 *   WooCommerce-plugin gebruikt. KRITIEK veld: `cloudPosId` (camelCase, de
 *   CloudPOS-instance-uuid). Zonder dat veld wordt de checkout NIET aan onze
 *   CloudPOS gekoppeld en 500't hun POST /api/payments bij elke bankkeuze
 *   ("select * from cloud_pos where uuid = ''"), en blijft de begunstigde
 *   leeg op de betaalpagina. Mét cloudPosId binden begunstigde (uit het
 *   CloudPOS-record) en IPN wél; `returnUrl` wordt op deze route genegeerd
 *   (urls.return blijft null — alle veldnaam-varianten live getest 29-07;
 *   de plugin stuurt hem ook en heeft hetzelfde). Terugkeer naar de site
 *   loopt dus via de IPN + reconcile + het CloudPOS-domain.
 *     velden: amount, reference, correlationId, cloudPosId, returnUrl, ipn
 *     -> { uuid, shortId, status, redirectUrl }
 *   De v1-route POST /api/v1/checkouts maakt óók checkouts aan maar negeert
 *   cloudPosId in elke geteste vorm — daarmee is elke v1-checkout onbetaalbaar.
 *   Niet meer gebruiken tot BANKpay+ dat fixt.
 * - GET  /api/checkout/<uuid> (Bearer)
 *     -> { checkout: { uuid, correlationId, status, status_credited, ... },
 *          amount: { value }, recipient, urls: { return, ipn } }
 * - Hosted betaalpagina:  https://bankpay.plus/checkout/<uuid>
 * - IPN: BANKpay+ pingt de ipn-URL; de status halen we daarna zelf
 *   authoritative op (zelfde patroon als de Wallid-provider).
 */

export type BankpayClientOptions = {
  /** Base URL, e.g. https://bankpay.plus */
  apiUrl: string
  /** Private API key uit het BANKpay+ dashboard (Developers -> API Keys). */
  privateKey: string
  /** CloudPOS instance UUID ("Gradepurity"). */
  clientId: string
  /** Begunstigde van de overboeking. Sinds de omschakeling naar de
   *  plugin-route (29-07) komt de begunstigde uit het CloudPOS-record bij
   *  BANKpay+ zelf; deze velden dienen alleen nog ter referentie. */
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
  /** `status_xs2a` — de open-banking-autorisatiestatus ("pending" tot SCA). */
  xs2a?: string | null
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
 * RCVD hoort hier NIET bij (fout ontdekt 29-07 via valse order #1947): sinds
 * de CloudPOS-binding zet BANKpay+ de checkout al op RCVD zodra de klant een
 * bank kiest en een IBAN invult — vóór enige SCA/betaling. RCVD = "opdracht
 * ontvangen", niet "betaald". De eerdere 28-07-observatie ("betaalde checkout
 * blijft RCVD") stamt uit het tijdperk zonder POS-binding en is daarmee
 * onbetrouwbaar.
 *
 * ACTC/ACCP/ACWC/ACWP hoorden hier óók niet bij (fout ontdekt 30-07 via valse
 * capture van testorder #1972): BANKpay+ zet de checkout al op ACTC binnen
 * seconden na de bankkeuze — "technisch gevalideerd", vóór SCA, zonder dat er
 * ooit betaald wordt. Alleen settlement-niveau telt als betaald: ACSC/ACCC
 * (afgerond) en ACSP (geld heeft de bank van de klant verlaten). De echte
 * betaling #1975 bevestigt het patroon: checkout ACCC + status_xs2a "success";
 * de valse #1972 bleef op ACTC + xs2a "pending" hangen. Overige betaald-
 * signalen: `status_credited` gezet, of een succes-status in `status_xs2a`
 * (de bankautorisatie springt pas na SCA).
 */
const PAID_STATUSES = new Set([
  "ACCC",
  "ACSC",
  "ACSP",
  "AcceptedSettlementCompleted",
  "AcceptedSettlementInProcess",
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

/** Eén statuscode (checkout of xs2a) naar het drieluik, of null als onbekend. */
function mapCode(code: string | null | undefined): MappedStatus | null {
  if (!code) {
    return null
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
  // created / SCArequired / RCVD / PDNG / UNKN / pending / ...
  return "pending"
}

/** Map een BANKpay+-statusrespons naar ons interne drieluik. */
export function mapBankpayStatus(status: BankpayStatus): MappedStatus {
  // `status_credited` gezet = geld gecrediteerd, ongeacht de statustekst.
  if (status.credited) {
    return "paid"
  }

  const checkout = mapCode(status.payment)
  if (checkout === "paid" || checkout === "failed") {
    return checkout
  }
  // Checkout-status is RCVD/pending — kijk naar de bankautorisatie (xs2a):
  // die springt pas na SCA en is daarmee het betrouwbare betaald-signaal.
  const xs2a = mapCode(status.xs2a)
  if (xs2a === "paid" || xs2a === "failed") {
    return xs2a
  }
  return checkout ?? xs2a ?? "pending"
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
    const res = await this.request<{
      uuid?: string
      shortId?: string
      status?: string
      redirectUrl?: string
    }>("/api/checkout", {
      method: "POST",
      idempotencyKey: params.idempotencyKey,
      json: {
        amount: params.amount,
        reference: params.reference,
        correlationId: params.correlationId,
        // Zonder cloudPosId geen CloudPOS-binding -> bankkeuze 500't en de
        // begunstigde blijft leeg. Zie het contract-commentaar bovenaan.
        cloudPosId: this.clientId,
        returnUrl: params.returnUrl,
        ipn: params.ipnUrl,
      },
    })

    if (!res.uuid) {
      throw new Error(
        `BANKpay+ /api/checkout -> geen uuid: ${JSON.stringify(res).slice(0, 200)}`
      )
    }
    return {
      uuid: res.uuid,
      redirectUrl: res.redirectUrl,
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
      status_xs2a?: string | null
    }>(`/api/checkout/${encodeURIComponent(checkoutUuid)}`, { method: "GET" })

    return {
      uuid: raw.checkout?.uuid,
      correlationId: raw.checkout?.correlationId,
      payment: raw.checkout?.status,
      credited: raw.checkout?.status_credited ?? null,
      xs2a: raw.status_xs2a ?? null,
      amount: raw.amount?.value,
    }
  }
}
