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
import { BankpayClient, mapBankpayStatus } from "./lib/client"

export type BankpayOptions = {
  /** Base URL van BANKpay+, e.g. https://bankpay.plus */
  apiUrl: string
  /** Private API key (Developers -> API Keys in het dashboard). */
  privateKey: string
  /** CloudPOS instance UUID. */
  clientId: string
  /** Publieke backend-URL — basis voor de IPN-URL die we per checkout meegeven. */
  backendUrl: string
  /** Storefront-origin, e.g. https://gradepurity.com — voor de retour-URL's. */
  storefrontUrl: string
  successPath?: string
  failPath?: string
}

type InjectedDependencies = {
  logger: Logger
}

/**
 * BANKpay+ hosted-checkout payment provider voor Medusa v2 (pay-by-bank,
 * SEPA Instant — settlement direct op onze eigen IBAN).
 *
 * Zelfde patroon als de Wallid-provider: sessie openen -> klant redirecten
 * naar de hosted pagina (`payment_link` in de sessie-data) -> BANKpay+ pingt
 * onze IPN-route -> die verifieert de status authoritative via wc-status en
 * draait processPaymentWorkflow. authorizePayment pollt de status live, zodat
 * de storefront-fallback en de reconcile-job hetzelfde bewezen pad delen.
 *
 * Geregistreerde key: pp_sepa_bankpay (identifier "sepa", id "bankpay").
 * IPN-route: <backend>/hooks/payment/pp_sepa_bankpay
 */
class BankpayProviderService extends AbstractPaymentProvider<BankpayOptions> {
  static identifier = "sepa"

  protected logger_: Logger
  protected options_: BankpayOptions
  protected client_: BankpayClient

  static validateOptions(options: Record<string, unknown>): void {
    const required = ["apiUrl", "privateKey", "clientId", "backendUrl"] as const
    for (const key of required) {
      if (!options[key]) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `BANKpay+: \`${key}\` is required in the provider options.`
        )
      }
    }
  }

  constructor(container: InjectedDependencies, options: BankpayOptions) {
    super(container, options)

    this.logger_ = container.logger
    this.options_ = options
    this.client_ = new BankpayClient({
      apiUrl: options.apiUrl,
      privateKey: options.privateKey,
      clientId: options.clientId,
    })
  }

  private buildReturnUrl(path: string | undefined, fallback: string): string {
    const origin = this.options_.storefrontUrl.replace(/\/$/, "")
    return `${origin}${path ?? fallback}`
  }

  private buildIpnUrl(sessionId: string): string {
    const base = this.options_.backendUrl.replace(/\/$/, "")
    return `${base}/hooks/payment/pp_sepa_bankpay?session_id=${encodeURIComponent(sessionId)}`
  }

  private async createCheckoutForSession(
    sessionId: string,
    amount: number,
    opts: { successUrl?: string; failUrl?: string } = {}
  ) {
    const checkout = await this.client_.createCheckout({
      // Zichtbaar als omschrijving op het bankafschrift van de klant.
      reference: `GradePurity ${sessionId.replace(/^payses_/, "").slice(-10)}`,
      amount: amount.toFixed(2),
      ipnUrl: this.buildIpnUrl(sessionId),
      correlationId: sessionId,
      returnUrl:
        opts.successUrl ??
        this.buildReturnUrl(this.options_.successPath, "/nl/bestelling-ontvangen"),
      checkoutUrl:
        opts.failUrl ?? this.buildReturnUrl(this.options_.failPath, "/nl/afrekenen"),
    })

    return {
      id: checkout.uuid,
      data: {
        checkout_uuid: checkout.uuid,
        payment_link: this.client_.checkoutPageUrl(checkout.uuid),
        session_id: sessionId,
        price_amount: amount,
      } as Record<string, unknown>,
    }
  }

  async initiatePayment(
    input: InitiatePaymentInput
  ): Promise<InitiatePaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    const sessionId = (data.session_id as string) ?? ""
    const amount = new BigNumber(input.amount).numeric

    const { id, data: sessionData } = await this.createCheckoutForSession(
      sessionId,
      amount,
      {
        successUrl: data.success_url as string | undefined,
        failUrl: data.fail_url as string | undefined,
      }
    )

    return { id, status: PaymentSessionStatus.PENDING, data: sessionData }
  }

  /** Actuele BANKpay+-status voor deze sessie (authoritative). */
  private async fetchMappedStatus(
    data: Record<string, unknown> | undefined
  ): Promise<"paid" | "failed" | "pending" | null> {
    const checkoutUuid = (data?.checkout_uuid as string) ?? ""
    if (!checkoutUuid) {
      return null
    }
    try {
      const status = await this.client_.getStatus(checkoutUuid)
      return mapBankpayStatus(status)
    } catch (e) {
      this.logger_.warn(
        `BANKpay+: status-call mislukt voor ${checkoutUuid}: ${
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
    const mapped = await this.fetchMappedStatus(data)

    switch (mapped) {
      case "paid":
        return { status: PaymentSessionStatus.AUTHORIZED, data }
      case "failed":
        return { status: PaymentSessionStatus.ERROR, data }
      default:
        return { status: PaymentSessionStatus.PENDING, data }
    }
  }

  async capturePayment(
    input: CapturePaymentInput
  ): Promise<CapturePaymentOutput> {
    // Het geld staat al op onze eigen IBAN zodra de bank de betaling uitvoert;
    // capture is een administratieve marker.
    return { data: { ...(input.data ?? {}), captured: true } }
  }

  async getPaymentStatus(
    input: GetPaymentStatusInput
  ): Promise<GetPaymentStatusOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    if (data.captured) {
      return { status: PaymentSessionStatus.CAPTURED, data }
    }
    const mapped = await this.fetchMappedStatus(data)
    switch (mapped) {
      case "paid":
        return { status: PaymentSessionStatus.AUTHORIZED, data }
      case "failed":
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

    // Checkouts liggen vast bij aanmaak; hercreëer als het bedrag wijzigt.
    if (!Number.isNaN(oldAmount) && oldAmount === newAmount) {
      return { status: PaymentSessionStatus.PENDING, data }
    }

    const sessionId = (data.session_id as string) ?? ""
    const fresh = await this.createCheckoutForSession(sessionId, newAmount)
    return { status: PaymentSessionStatus.PENDING, data: fresh.data }
  }

  async cancelPayment(
    input: CancelPaymentInput
  ): Promise<CancelPaymentOutput> {
    // Onbetaalde checkouts verlopen vanzelf; er is geen void-endpoint.
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
    // Refunds = zelf terugstorten vanaf de Finom-rekening (geld staat bij ons).
    const sessionId =
      (input.data as Record<string, unknown> | undefined)?.session_id ?? "?"
    this.logger_.warn(
      `BANKpay+: refund aangevraagd (sessie ${sessionId}). Handmatig terugstorten vanaf de eigen rekening.`
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
    // De IPN wordt afgehandeld door de statische route
    // /hooks/payment/pp_sepa_bankpay (zelfde reden als bij Wallid: Medusa's
    // ingebouwde route zou `pp_pp_sepa_bankpay` zoeken). Deze methode blijft
    // als vangnet voor het geval Medusa hier toch ooit binnenkomt.
    void payload
    return { action: PaymentActions.NOT_SUPPORTED }
  }
}

export default BankpayProviderService
