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

export type PaymentMethod = "bank" | "crypto" | "wallid" | "other"

/**
 * Bankgegevens voor de vooruitbetaling-mail. Spiegel van BANK_DETAILS in de
 * storefront (forma/src/lib/payment-info.ts) — bij wijziging beide aanpassen.
 */
const BANK = {
  payee: "Gradepurity",
  iban: "NL81 FNOM 0779 1759 17",
  bic: "FNOMNL22",
} as const

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
  /** E-mailadres van de klant — alleen gebruikt in de admin-notificatie. */
  customer_email?: string
}

export type RenderedEmail = { subject: string; html: string }

export type TemplateId =
  | "order-placed"
  | "payment-reminder"
  | "payment-captured"
  | "order-shipped"
  | "admin-new-order"

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
    case "payment-reminder":
      return paymentReminder(data, locale)
    case "payment-captured":
      return paymentCaptured(data, locale)
    case "order-shipped":
      return orderShipped(data, locale)
    case "admin-new-order":
      return adminNewOrder(data)
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

  const bankBlock = method === "bank" ? bankDetailsBlock(data, locale) : ""

  const body = `
    <p style="margin:0 0 16px;">${c.placed.intro}</p>
    <div style="background:#FBFAF6;border:1px solid ${UI.line};border-radius:6px;padding:16px 20px;margin:0 0 24px;">
      <span style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${UI.muted};">${c.orderNumber}</span><br/>
      <span style="font-family:Georgia,serif;font-size:20px;color:${UI.navy};">${orderNo}</span>
    </div>
    <p style="margin:0 0 4px;font-weight:700;">${payNote.title}</p>
    <p style="margin:0 0 24px;color:${UI.muted};">${payNote.text}</p>
    ${bankBlock}
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

// ── 1b. Betaalherinnering — vooruitbetaling nog niet binnen ───────────────────

function paymentReminder(data: OrderEmailData, locale: Locale): RenderedEmail {
  const c = COPY[locale]
  const orderNo = `#${data.display_id}`
  const body = `
    <p style="margin:0 0 16px;">${c.reminder.intro}</p>
    <div style="background:#FBFAF6;border:1px solid ${UI.line};border-radius:6px;padding:16px 20px;margin:0 0 24px;">
      <span style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${UI.muted};">${c.orderNumber}</span><br/>
      <span style="font-family:Georgia,serif;font-size:20px;color:${UI.navy};">${orderNo}</span>
    </div>
    <p style="margin:0 0 24px;color:${UI.muted};">${c.reminder.text}</p>
    ${bankDetailsBlock(data, locale)}
    <h2 style="margin:0 0 4px;font-family:Georgia,serif;font-size:18px;font-weight:400;color:${UI.text};">${c.summary}</h2>
    ${renderOrderTable(data.items, data.totals, data.currency_code, locale)}
    <p style="margin:24px 0 0;color:${UI.muted};">${c.reminder.outro}</p>
  `
  return {
    subject: `${c.reminder.subject} ${orderNo}`,
    html: renderLayout({ preheader: c.reminder.preheader, heading: c.reminder.heading, body }, locale),
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

// ── 4. Admin-notificatie — nieuwe bestelling (intern, altijd NL) ──────────────

function adminNewOrder(data: OrderEmailData): RenderedEmail {
  const locale: Locale = "nl"
  const orderNo = `#${data.display_id}`
  const method = data.payment_method ?? "other"
  const methodLabel =
    method === "wallid"
      ? "Wallid — BETAALD"
      : method === "bank"
        ? "Bankoverschrijving — wacht op betaling (kenmerk GP-" +
          String(data.display_id).padStart(5, "0") +
          ")"
        : method === "crypto"
          ? "Crypto"
          : "Onbekend"

  const body = `
    <p style="margin:0 0 16px;">Er is een nieuwe bestelling geplaatst op gradepurity.com.</p>
    <div style="background:#FBFAF6;border:1px solid ${UI.line};border-radius:6px;padding:16px 20px;margin:0 0 24px;">
      <table role="presentation" cellpadding="0" cellspacing="0">
        <tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${UI.muted};padding:3px 16px 3px 0;">Bestelnummer</td><td style="font-family:Georgia,serif;font-size:15px;color:${UI.navy};padding:3px 0;">${orderNo}</td></tr>
        <tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${UI.muted};padding:3px 16px 3px 0;">Klant</td><td style="font-family:Georgia,serif;font-size:15px;color:${UI.navy};padding:3px 0;">${escapeAttr(data.customer_email ?? "onbekend")}</td></tr>
        <tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${UI.muted};padding:3px 16px 3px 0;">Betaling</td><td style="font-family:Georgia,serif;font-size:15px;color:${UI.navy};padding:3px 0;">${methodLabel}</td></tr>
        ${
          (data.totals.discount ?? 0) > 0
            ? `<tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${UI.muted};padding:3px 16px 3px 0;">Kortingscode</td><td style="font-family:Georgia,serif;font-size:15px;color:#B4552D;padding:3px 0;"><strong>${escapeAttr((data.totals.promo_code ?? "onbekend").toUpperCase())}</strong> (&minus;${money(data.totals.discount ?? 0, data.currency_code, locale)})</td></tr>`
            : ""
        }
        <tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${UI.muted};padding:3px 16px 3px 0;">Totaal</td><td style="font-family:Georgia,serif;font-size:15px;color:${UI.navy};padding:3px 0;">${money(data.totals.total, data.currency_code, locale)}</td></tr>
      </table>
    </div>
    ${renderOrderTable(data.items, data.totals, data.currency_code, locale)}
    ${addressBlock(data, COPY.nl)}
    ${button("https://backend-production-2a64.up.railway.app/app/orders", "Open Medusa-admin")}
  `
  return {
    subject: `Nieuwe bestelling ${orderNo} — ${money(data.totals.total, data.currency_code, locale)} (${method === "wallid" ? "betaald" : method === "bank" ? "vooruitbetaling" : method})`,
    html: renderLayout(
      { preheader: `Nieuwe bestelling ${orderNo}`, heading: "Nieuwe bestelling", body },
      locale
    ),
  }
}

// ── Gedeelde fragmenten ───────────────────────────────────────────────────────

/**
 * Bankgegevens-tabel voor vooruitbetaling, met het GP-kenmerk in hetzelfde
 * formaat als op de bevestigingspagina (GP-00012) zodat overschrijvingen op
 * één kenmerk te matchen zijn.
 */
function bankDetailsBlock(data: OrderEmailData, locale: Locale): string {
  const labels = COPY[locale].placed.bankDetails
  const orderRef = `GP-${String(data.display_id).padStart(5, "0")}`
  // IBAN/BIC/kenmerk in monospace: in Georgia is de hoofdletter O vrijwel
  // gelijk aan een nul (FNOM leest als FN0M) — bij overtypen gaat dat mis.
  const bankRow = (label: string, value: string, mono = false) => `
      <tr>
        <td style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${UI.muted};padding:3px 16px 3px 0;white-space:nowrap;">${label}</td>
        <td style="font-family:${mono ? "Consolas,'Courier New',monospace" : "Georgia,serif"};font-size:${mono ? 14 : 15}px;color:${UI.navy};padding:3px 0;letter-spacing:${mono ? "0.5px" : "normal"};">${value}</td>
      </tr>`
  return `
    <div style="background:#FBFAF6;border:1px solid ${UI.line};border-radius:6px;padding:16px 20px;margin:0 0 24px;">
      <table role="presentation" cellpadding="0" cellspacing="0">
        ${bankRow(labels.payee, BANK.payee)}
        ${bankRow("IBAN", BANK.iban, true)}
        ${bankRow("BIC", BANK.bic, true)}
        ${bankRow(labels.amount, money(data.totals.total, data.currency_code, locale))}
        ${bankRow(labels.reference, `<strong>${orderRef}</strong>`, true)}
      </table>
    </div>`
}

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
      cta: "Naar GradePurity",
      bank: {
        title: "Maak het bedrag over om je bestelling af te ronden",
        text: "Gebruik onderstaande gegevens en vermeld het kenmerk bij je overschrijving. Zodra de betaling binnen is, sturen we je een bevestiging en verzenden we je bestelling.",
      },
      bankDetails: {
        payee: "Ten name van",
        amount: "Bedrag",
        reference: "Kenmerk",
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
    reminder: {
      subject: "Herinnering: je bestelling wacht op betaling —",
      preheader: "We hebben je betaling nog niet ontvangen.",
      heading: "Je bestelling wacht nog op betaling",
      intro: "Een tijdje geleden plaatste je een bestelling bij GradePurity, maar we hebben je betaling nog niet ontvangen.",
      text: "Maak het bedrag over met onderstaande gegevens en vermeld het kenmerk bij je overschrijving. Zodra de betaling binnen is, sturen we je een bevestiging en verzenden we je bestelling.",
      outro: "Al betaald? Dan kunnen de betaling en deze mail elkaar gekruist hebben — je hoeft niets te doen. Wil je de bestelling liever annuleren of heb je een vraag? Reageer dan gerust op deze mail.",
    },
    paid: {
      subject: "Betaling ontvangen —",
      preheader: "Je betaling is binnen, je bestelling wordt klaargemaakt.",
      heading: "Betaling ontvangen",
      badge: "Betaling bevestigd",
      intro: "Goed nieuws — we hebben je betaling ontvangen en je bestelling is bevestigd.",
      next: "We maken je bestelling klaar voor verzending. Je krijgt een bericht met track & trace zodra het pakket onderweg is.",
      cta: "Naar GradePurity",
    },
    shipped: {
      subject: "Je bestelling is onderweg —",
      preheader: "Je pakket is verzonden.",
      heading: "Je bestelling is onderweg",
      intro: "Je bestelling is verzonden en is onderweg naar je toe.",
      carrier: "Vervoerder",
      trackingNo: "Track & trace",
      cta: "Volg je pakket",
      ctaFallback: "Naar GradePurity",
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
      cta: "Go to GradePurity",
      bank: {
        title: "Transfer the amount to complete your order",
        text: "Use the details below and include the reference with your transfer. Once the payment arrives, we'll send a confirmation and ship your order.",
      },
      bankDetails: {
        payee: "Payee",
        amount: "Amount",
        reference: "Reference",
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
    reminder: {
      subject: "Reminder: your order is awaiting payment —",
      preheader: "We haven't received your payment yet.",
      heading: "Your order is still awaiting payment",
      intro: "A little while ago you placed an order at GradePurity, but we haven't received your payment yet.",
      text: "Transfer the amount using the details below and include the reference with your transfer. Once the payment arrives, we'll send a confirmation and ship your order.",
      outro: "Already paid? Then your payment and this email may have crossed — no action needed. Prefer to cancel your order, or have a question? Just reply to this email.",
    },
    paid: {
      subject: "Payment received —",
      preheader: "Your payment is in, your order is being prepared.",
      heading: "Payment received",
      badge: "Payment confirmed",
      intro: "Good news — we've received your payment and your order is confirmed.",
      next: "We're preparing your order for shipment. You'll get a message with tracking as soon as it's on its way.",
      cta: "Go to GradePurity",
    },
    shipped: {
      subject: "Your order is on its way —",
      preheader: "Your parcel has shipped.",
      heading: "Your order is on its way",
      intro: "Your order has shipped and is on its way to you.",
      carrier: "Carrier",
      trackingNo: "Tracking",
      cta: "Track your parcel",
      ctaFallback: "Go to GradePurity",
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
      cta: "Zu GradePurity",
      bank: {
        title: "Überweisen Sie den Betrag, um Ihre Bestellung abzuschließen",
        text: "Nutzen Sie die untenstehenden Daten und geben Sie den Verwendungszweck bei Ihrer Überweisung an. Sobald die Zahlung eingeht, senden wir eine Bestätigung und versenden Ihre Bestellung.",
      },
      bankDetails: {
        payee: "Empfänger",
        amount: "Betrag",
        reference: "Verwendungszweck",
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
    reminder: {
      subject: "Erinnerung: Ihre Bestellung wartet auf Zahlung —",
      preheader: "Wir haben Ihre Zahlung noch nicht erhalten.",
      heading: "Ihre Bestellung wartet noch auf Zahlung",
      intro: "Vor einiger Zeit haben Sie eine Bestellung bei GradePurity aufgegeben, wir haben Ihre Zahlung jedoch noch nicht erhalten.",
      text: "Überweisen Sie den Betrag mit den untenstehenden Daten und geben Sie den Verwendungszweck bei Ihrer Überweisung an. Sobald die Zahlung eingeht, senden wir eine Bestätigung und versenden Ihre Bestellung.",
      outro: "Bereits bezahlt? Dann haben sich Zahlung und diese E-Mail möglicherweise überschnitten — Sie müssen nichts tun. Möchten Sie die Bestellung lieber stornieren oder haben Sie eine Frage? Antworten Sie einfach auf diese E-Mail.",
    },
    paid: {
      subject: "Zahlung erhalten —",
      preheader: "Ihre Zahlung ist eingegangen, Ihre Bestellung wird vorbereitet.",
      heading: "Zahlung erhalten",
      badge: "Zahlung bestätigt",
      intro: "Gute Nachrichten — wir haben Ihre Zahlung erhalten und Ihre Bestellung ist bestätigt.",
      next: "Wir bereiten Ihre Bestellung für den Versand vor. Sie erhalten eine Nachricht mit Sendungsverfolgung, sobald das Paket unterwegs ist.",
      cta: "Zu GradePurity",
    },
    shipped: {
      subject: "Ihre Bestellung ist unterwegs —",
      preheader: "Ihr Paket wurde versendet.",
      heading: "Ihre Bestellung ist unterwegs",
      intro: "Ihre Bestellung wurde versendet und ist auf dem Weg zu Ihnen.",
      carrier: "Versanddienstleister",
      trackingNo: "Sendungsverfolgung",
      cta: "Paket verfolgen",
      ctaFallback: "Zu GradePurity",
    },
  },
} as const
