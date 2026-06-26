// Template-registry: zet een template-id + data om in onderwerp + HTML.
// De subscriber levert de data aan, de provider (service.ts) roept render() aan.

import {
  Locale,
  OrderLine,
  OrderTotals,
  ShippingAddress,
  renderLayout,
  renderOrderTable,
  renderAddress,
  money,
  UI,
} from "./layout"

export type PaymentMethod = "bank" | "crypto" | "other"

/** Data die elke order-mail nodig heeft (door de subscriber samengesteld). */
export type OrderEmailData = {
  locale?: Locale
  display_id: number | string
  currency_code: string
  items: OrderLine[]
  totals: OrderTotals
  shipping_address?: ShippingAddress | null
  /** Voor "in afwachting van betaling": hoe betaalt de klant. */
  payment_method?: PaymentMethod
  /** Verzendgegevens, alleen voor de verzonden-mail. */
  tracking_numbers?: string[]
  tracking_url?: string | null
  carrier?: string | null
}

export type RenderedEmail = { subject: string; html: string }

export type TemplateId = "order-placed" | "payment-captured" | "order-shipped"

const ORDER_URL = "https://gradepurity.com"

function resolveLocale(data: OrderEmailData): Locale {
  if (data.locale) return data.locale
  const cc = data.shipping_address?.country_code?.toLowerCase()
  if (cc === "de" || cc === "at") return "de"
  if (cc === "nl" || cc === "be") return "nl"
  return cc ? "en" : "nl" // geen adres bekend -> NL (primaire markt)
}

/** Hoofdingang: render een template-id naar onderwerp + HTML. */
export function render(template: TemplateId, data: OrderEmailData): RenderedEmail {
  const locale = resolveLocale(data)
  switch (template) {
    case "order-placed":
      return orderPlaced(data, locale)
    case "payment-captured":
      return paymentCaptured(data, locale)
    case "order-shipped":
      return orderShipped(data, locale)
    default:
      throw new Error(`Onbekende e-mailtemplate: ${template}`)
  }
}

// ── 1. Bestelling geplaatst — in afwachting van betaling ──────────────────────

function orderPlaced(data: OrderEmailData, locale: Locale): RenderedEmail {
  const c = COPY[locale]
  const orderNo = `#${data.display_id}`
  const method = data.payment_method ?? "other"
  const payNote = method === "bank" ? c.placed.bank : method === "crypto" ? c.placed.crypto : c.placed.generic

  const body = `
    <p style="margin:0 0 16px;">${c.placed.intro}</p>
    <div style="background:#FBFAF6;border:1px solid ${UI.line};border-radius:6px;padding:16px 20px;margin:0 0 24px;">
      <span style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${UI.muted};">${c.orderNumber}</span><br/>
      <span style="font-family:Georgia,serif;font-size:20px;color:${UI.navy};">${orderNo}</span>
    </div>
    <p style="margin:0 0 4px;font-weight:700;">${payNote.title}</p>
    <p style="margin:0 0 24px;color:${UI.muted};">${payNote.text}</p>
    <h2 style="margin:0 0 4px;font-family:Georgia,serif;font-size:18px;font-weight:400;color:${UI.text};">${c.summary}</h2>
    ${renderOrderTable(data.items, data.totals, data.currency_code, locale)}
    ${addressBlock(data, c)}
    ${button(ORDER_URL, c.placed.cta)}
  `
  return {
    subject: `${c.placed.subject} ${orderNo}`,
    html: renderLayout({ preheader: c.placed.preheader, heading: c.placed.heading, body }, locale),
  }
}

// ── 2. Betaling ontvangen — bestelling bevestigd ──────────────────────────────

function paymentCaptured(data: OrderEmailData, locale: Locale): RenderedEmail {
  const c = COPY[locale]
  const orderNo = `#${data.display_id}`
  const body = `
    <p style="margin:0 0 16px;">${c.paid.intro}</p>
    <div style="background:#F2F6EF;border:1px solid #D8E3CF;border-radius:6px;padding:16px 20px;margin:0 0 24px;">
      <span style="font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#3F6B2E;">&#10003; ${c.paid.badge}</span><br/>
      <span style="font-family:Georgia,serif;font-size:20px;color:${UI.navy};">${orderNo} &mdash; ${money(data.totals.total, data.currency_code, locale)}</span>
    </div>
    <p style="margin:0 0 24px;color:${UI.muted};">${c.paid.next}</p>
    <h2 style="margin:0 0 4px;font-family:Georgia,serif;font-size:18px;font-weight:400;color:${UI.text};">${c.summary}</h2>
    ${renderOrderTable(data.items, data.totals, data.currency_code, locale)}
    ${addressBlock(data, c)}
    ${button(ORDER_URL, c.paid.cta)}
  `
  return {
    subject: `${c.paid.subject} ${orderNo}`,
    html: renderLayout({ preheader: c.paid.preheader, heading: c.paid.heading, body }, locale),
  }
}

// ── 3. Bestelling verzonden — met track & trace ───────────────────────────────

function orderShipped(data: OrderEmailData, locale: Locale): RenderedEmail {
  const c = COPY[locale]
  const orderNo = `#${data.display_id}`
  const numbers = data.tracking_numbers ?? []
  const trackBlock = numbers.length
    ? `
    <div style="background:#FBFAF6;border:1px solid ${UI.line};border-radius:6px;padding:16px 20px;margin:0 0 24px;">
      ${data.carrier ? `<span style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${UI.muted};">${c.shipped.carrier}: ${escapeAttr(data.carrier)}</span><br/>` : ""}
      <span style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${UI.muted};">${c.shipped.trackingNo}</span><br/>
      <span style="font-family:Georgia,serif;font-size:18px;color:${UI.navy};">${numbers.map(escapeAttr).join(", ")}</span>
    </div>`
    : ""
  const cta = data.tracking_url ? button(data.tracking_url, c.shipped.cta) : button(ORDER_URL, c.shipped.ctaFallback)

  const body = `
    <p style="margin:0 0 16px;">${c.shipped.intro}</p>
    <div style="margin:0 0 24px;">
      <span style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${UI.muted};">${c.orderNumber}</span>
      <span style="font-family:Georgia,serif;font-size:18px;color:${UI.navy};"> ${orderNo}</span>
    </div>
    ${trackBlock}
    ${cta}
  `
  return {
    subject: `${c.shipped.subject} ${orderNo}`,
    html: renderLayout({ preheader: c.shipped.preheader, heading: c.shipped.heading, body }, locale),
  }
}

// ── Gedeelde fragmenten ───────────────────────────────────────────────────────

function addressBlock(data: OrderEmailData, c: { shippingTo: string }): string {
  if (!data.shipping_address) return ""
  return `
    <h2 style="margin:24px 0 4px;font-family:Georgia,serif;font-size:18px;font-weight:400;color:${UI.text};">${c.shippingTo}</h2>
    <p style="margin:0 0 24px;color:${UI.muted};line-height:1.6;">${renderAddress(data.shipping_address)}</p>`
}

function button(href: string, label: string): string {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;"><tr>
    <td style="border-radius:4px;background:${UI.navy};">
      <a href="${escapeAttr(href)}" style="display:inline-block;padding:13px 28px;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#FFFFFF;text-decoration:none;letter-spacing:0.5px;">${label}</a>
    </td>
  </tr></table>`
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// ── Copy (NL / EN / DE) ───────────────────────────────────────────────────────
// Directe verkoop-toon, geen douane/discreet-framing (zie merkrichtlijn).

const COPY = {
  nl: {
    orderNumber: "Bestelnummer",
    summary: "Overzicht",
    shippingTo: "Verzendadres",
    placed: {
      subject: "We hebben je bestelling ontvangen —",
      preheader: "Bedankt voor je bestelling bij GradePurity.",
      heading: "Bedankt voor je bestelling",
      intro: "We hebben je bestelling ontvangen en gaan ermee aan de slag zodra de betaling binnen is.",
      cta: "Bekijk je bestelling",
      bank: {
        title: "In afwachting van je overschrijving",
        text: "Je ontvangt de betaalgegevens in een aparte stap. Zodra de overschrijving binnen is, sturen we je een bevestiging en verzenden we je bestelling.",
      },
      crypto: {
        title: "In afwachting van je betaling",
        text: "Je crypto-betaling wordt bevestigd op de blockchain. Zodra de transactie bevestigd is, ontvang je van ons een bevestiging en verzenden we je bestelling.",
      },
      generic: {
        title: "In afwachting van betaling",
        text: "Zodra je betaling verwerkt is, ontvang je een bevestiging en verzenden we je bestelling.",
      },
    },
    paid: {
      subject: "Betaling ontvangen —",
      preheader: "Je betaling is binnen, je bestelling wordt klaargemaakt.",
      heading: "Betaling ontvangen",
      badge: "Betaling bevestigd",
      intro: "Goed nieuws — we hebben je betaling ontvangen en je bestelling is bevestigd.",
      next: "We maken je bestelling klaar voor verzending. Je krijgt een bericht met track & trace zodra het pakket onderweg is.",
      cta: "Bekijk je bestelling",
    },
    shipped: {
      subject: "Je bestelling is onderweg —",
      preheader: "Je pakket is verzonden.",
      heading: "Je bestelling is onderweg",
      intro: "Je bestelling is verzonden en is onderweg naar je toe.",
      carrier: "Vervoerder",
      trackingNo: "Track & trace",
      cta: "Volg je pakket",
      ctaFallback: "Bekijk je bestelling",
    },
  },
  en: {
    orderNumber: "Order number",
    summary: "Summary",
    shippingTo: "Shipping address",
    placed: {
      subject: "We received your order —",
      preheader: "Thank you for your order at GradePurity.",
      heading: "Thank you for your order",
      intro: "We've received your order and will get started as soon as your payment comes in.",
      cta: "View your order",
      bank: {
        title: "Awaiting your bank transfer",
        text: "You'll receive the payment details in a separate step. Once the transfer arrives, we'll send a confirmation and ship your order.",
      },
      crypto: {
        title: "Awaiting your payment",
        text: "Your crypto payment is being confirmed on the blockchain. Once the transaction is confirmed, we'll send a confirmation and ship your order.",
      },
      generic: {
        title: "Awaiting payment",
        text: "As soon as your payment is processed, you'll receive a confirmation and we'll ship your order.",
      },
    },
    paid: {
      subject: "Payment received —",
      preheader: "Your payment is in, your order is being prepared.",
      heading: "Payment received",
      badge: "Payment confirmed",
      intro: "Good news — we've received your payment and your order is confirmed.",
      next: "We're preparing your order for shipment. You'll get a message with tracking as soon as it's on its way.",
      cta: "View your order",
    },
    shipped: {
      subject: "Your order is on its way —",
      preheader: "Your parcel has shipped.",
      heading: "Your order is on its way",
      intro: "Your order has shipped and is on its way to you.",
      carrier: "Carrier",
      trackingNo: "Tracking",
      cta: "Track your parcel",
      ctaFallback: "View your order",
    },
  },
  de: {
    orderNumber: "Bestellnummer",
    summary: "Übersicht",
    shippingTo: "Lieferadresse",
    placed: {
      subject: "Wir haben Ihre Bestellung erhalten —",
      preheader: "Vielen Dank für Ihre Bestellung bei GradePurity.",
      heading: "Vielen Dank für Ihre Bestellung",
      intro: "Wir haben Ihre Bestellung erhalten und legen los, sobald Ihre Zahlung eingegangen ist.",
      cta: "Bestellung ansehen",
      bank: {
        title: "Warten auf Ihre Überweisung",
        text: "Die Zahlungsdaten erhalten Sie in einem separaten Schritt. Sobald die Überweisung eingeht, senden wir eine Bestätigung und versenden Ihre Bestellung.",
      },
      crypto: {
        title: "Warten auf Ihre Zahlung",
        text: "Ihre Krypto-Zahlung wird auf der Blockchain bestätigt. Sobald die Transaktion bestätigt ist, senden wir eine Bestätigung und versenden Ihre Bestellung.",
      },
      generic: {
        title: "Warten auf Zahlung",
        text: "Sobald Ihre Zahlung verarbeitet ist, erhalten Sie eine Bestätigung und wir versenden Ihre Bestellung.",
      },
    },
    paid: {
      subject: "Zahlung erhalten —",
      preheader: "Ihre Zahlung ist eingegangen, Ihre Bestellung wird vorbereitet.",
      heading: "Zahlung erhalten",
      badge: "Zahlung bestätigt",
      intro: "Gute Nachrichten — wir haben Ihre Zahlung erhalten und Ihre Bestellung ist bestätigt.",
      next: "Wir bereiten Ihre Bestellung für den Versand vor. Sie erhalten eine Nachricht mit Sendungsverfolgung, sobald das Paket unterwegs ist.",
      cta: "Bestellung ansehen",
    },
    shipped: {
      subject: "Ihre Bestellung ist unterwegs —",
      preheader: "Ihr Paket wurde versendet.",
      heading: "Ihre Bestellung ist unterwegs",
      intro: "Ihre Bestellung wurde versendet und ist auf dem Weg zu Ihnen.",
      carrier: "Versanddienstleister",
      trackingNo: "Sendungsverfolgung",
      cta: "Paket verfolgen",
      ctaFallback: "Bestellung ansehen",
    },
  },
} as const
