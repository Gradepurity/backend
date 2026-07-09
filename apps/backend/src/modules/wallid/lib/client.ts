import crypto from "crypto"

/**
 * Thin client voor de Wallid Payment Gateway API + webhook-verificatie.
 *
 * Wallid host de betaalpagina zelf: wij maken een payment aan, sturen de klant
 * naar `payment_link`, en Wallid meldt de finale status via webhook. Bedragen
 * gaan in minor units (centen).
 *
 * Docs: payment-api_v_0.2.md (integratie-guide van Wallid).
 */

export type WallidClientOptions = {
  /** Base URL van de gateway, e.g. https://payment-api.wallid.co/api/payment-gw/v1 */
  apiUrl: string
  keyId: string
  keySecret: string
  /** Door ons gekozen webhook-secret (ook aangeleverd bij Wallid). */
  webhookSecret: string
}

export type WallidItem = {
  name: string
  category: string
  price_minor: number
  image_url: string
  product_url: string
}

export type CreatePaymentParams = {
  /** Uniek per merchant — wij gebruiken de Medusa payment-session-id (+ suffix bij hercreatie). */
  orderId: string
  /** Bedrag in minor units (centen). */
  amountMinor: number
  /** ISO 4217, e.g. "EUR". */
  currency: string
  successUrl: string
  failUrl: string
  items: WallidItem[]
  customerEmail?: string
  description?: string
  locale?: string
  /** RFC3339 — default bij Wallid is 15 minuten; wij rekken op. */
  expiresAt?: string
}

export type WallidPayment = {
  api_payment_id: string
  order_id: string
  status: "NEW" | "PENDING" | "SUCCESS" | "FAILED" | "EXPIRED"
  statusError?: string
  payment_link: string
  amount: number
  currency: string
  expires_at?: string
  created_at?: string
  [key: string]: unknown
}

/** Hoe oud een webhook-timestamp maximaal mag zijn (replay-bescherming). */
const MAX_WEBHOOK_AGE_SECONDS = 300

export class WallidClient {
  private readonly apiUrl: string
  private readonly authHeader: string
  private readonly webhookSecret: string

  constructor(options: WallidClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "")
    this.authHeader =
      "Basic " +
      Buffer.from(`${options.keyId}:${options.keySecret}`).toString("base64")
    this.webhookSecret = options.webhookSecret
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      ...init,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    })

    const text = await res.text()
    if (!res.ok) {
      // Wallid geeft fouten als plain text terug (bv. "amount must be positive").
      throw new Error(`Wallid ${path} -> HTTP ${res.status}: ${text || res.statusText}`)
    }

    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(`Wallid ${path} -> onleesbaar antwoord: ${text.slice(0, 200)}`)
    }
  }

  createPayment(params: CreatePaymentParams): Promise<WallidPayment> {
    return this.request<WallidPayment>("/create", {
      method: "POST",
      body: JSON.stringify({
        order_id: params.orderId,
        amount: params.amountMinor,
        currency: params.currency.toUpperCase(),
        success_url: params.successUrl,
        fail_url: params.failUrl,
        items: params.items,
        customer_email: params.customerEmail,
        description: params.description,
        locale: params.locale,
        expires_at: params.expiresAt,
      }),
    })
  }

  getPayment(apiPaymentId: string): Promise<WallidPayment> {
    return this.request<WallidPayment>(
      `/status?apiPaymentId=${encodeURIComponent(apiPaymentId)}`,
      { method: "GET" }
    )
  }

  /**
   * Verifieer een Wallid-webhook. `X-Webhook-Signature` = "sha256=<hex>", een
   * HMAC-SHA256 over "{X-Webhook-Timestamp}.{raw body}" met ons webhook-secret.
   * De timestamp mag maximaal 5 minuten oud zijn (replay-bescherming).
   */
  verifyWebhookSignature(
    rawBody: string,
    timestamp: string | undefined,
    signature: string | undefined
  ): boolean {
    if (!timestamp || !signature) {
      return false
    }
    const ts = Number.parseInt(timestamp, 10)
    if (!Number.isFinite(ts)) {
      return false
    }
    if (Math.abs(Date.now() / 1000 - ts) > MAX_WEBHOOK_AGE_SECONDS) {
      return false
    }

    const expected =
      "sha256=" +
      crypto
        .createHmac("sha256", this.webhookSecret)
        .update(`${timestamp}.${rawBody}`)
        .digest("hex")

    const a = Buffer.from(expected, "utf8")
    const b = Buffer.from(signature, "utf8")
    if (a.length !== b.length) {
      return false
    }
    return crypto.timingSafeEqual(a, b)
  }
}
