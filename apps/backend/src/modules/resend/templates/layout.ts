// Gedeelde HTML-shell voor alle transactionele mails.
// E-mailclients negeren <style>-blokken en externe fonts grotendeels, dus alles
// staat inline en we leunen op web-safe fallbacks (Georgia ~ Bodoni-gevoel).

export type Locale = "nl" | "en" | "de"

// GradePurity-palet (zie design system): marineblauw, near-black, off-white, brons.
const COLORS = {
  bg: "#F5F3EE",
  card: "#FFFFFF",
  text: "#1A1A1A",
  muted: "#6B6B6B",
  navy: "#1F3F6E",
  bronze: "#9C7A3C",
  line: "#E5E1D8",
}

export type LayoutContent = {
  /** Voorvertoning in de inbox (preheader), onzichtbaar in de body. */
  preheader: string
  /** Grote serif-kop bovenin de kaart. */
  heading: string
  /** HTML-body tussen kop en footer. */
  body: string
}

/**
 * Wrapt de inhoud van een specifieke mail in de merk-shell met header en footer.
 */
export function renderLayout(content: LayoutContent, locale: Locale): string {
  const footer = FOOTER[locale]
  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light only" />
<title>GradePurity</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${content.preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.bg};padding:32px 0;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">

      <!-- Header -->
      <tr><td align="center" style="padding:8px 24px 24px;">
        <span style="font-family:Georgia,'Times New Roman',serif;font-size:24px;letter-spacing:2px;color:${COLORS.navy};text-transform:uppercase;">GradePurity</span>
        <div style="margin-top:6px;height:2px;width:48px;background:${COLORS.bronze};margin-left:auto;margin-right:auto;"></div>
      </td></tr>

      <!-- Kaart -->
      <tr><td style="background:${COLORS.card};border:1px solid ${COLORS.line};border-radius:8px;padding:40px;">
        <h1 style="margin:0 0 24px;font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:400;line-height:1.25;color:${COLORS.text};">${content.heading}</h1>
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:${COLORS.text};">
          ${content.body}
        </div>
      </td></tr>

      <!-- Footer -->
      <tr><td style="padding:28px 24px;text-align:center;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:${COLORS.muted};">
        ${footer}
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`
}

const FOOTER: Record<Locale, string> = {
  nl: `GradePurity &middot; <a href="https://gradepurity.com" style="color:${COLORS.navy};text-decoration:none;">gradepurity.com</a><br/>Vragen? Mail ons op <a href="mailto:info@gradepurity.com" style="color:${COLORS.navy};text-decoration:none;">info@gradepurity.com</a>`,
  en: `GradePurity &middot; <a href="https://gradepurity.com" style="color:${COLORS.navy};text-decoration:none;">gradepurity.com</a><br/>Questions? Email us at <a href="mailto:info@gradepurity.com" style="color:${COLORS.navy};text-decoration:none;">info@gradepurity.com</a>`,
  de: `GradePurity &middot; <a href="https://gradepurity.com" style="color:${COLORS.navy};text-decoration:none;">gradepurity.com</a><br/>Fragen? Schreiben Sie uns an <a href="mailto:info@gradepurity.com" style="color:${COLORS.navy};text-decoration:none;">info@gradepurity.com</a>`,
}

// ── Gedeelde bouwstenen voor mails met een orderoverzicht ─────────────────────

export const UI = COLORS

export type OrderLine = {
  title: string
  subtitle?: string | null
  quantity: number
  unit_price: number
}

export type OrderTotals = {
  subtotal: number
  /** Kortingscode-korting (promotie); 0/undefined = geen kortingsregel. */
  discount?: number
  /** Gebruikte kortingscode(s), voor het label "Korting (CODE)". */
  promo_code?: string | null
  shipping: number
  tax: number
  total: number
}

export type ShippingAddress = {
  first_name?: string | null
  last_name?: string | null
  address_1?: string | null
  postal_code?: string | null
  city?: string | null
  country_code?: string | null
  phone?: string | null
}

/** Bedragen in Medusa v2 zijn decimalen (19.99), niet centen. */
export function money(amount: number, currency: string, locale: Locale): string {
  try {
    return new Intl.NumberFormat(localeTag(locale), {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount)
  } catch {
    return `${currency.toUpperCase()} ${amount.toFixed(2)}`
  }
}

function localeTag(locale: Locale): string {
  return locale === "nl" ? "nl-NL" : locale === "de" ? "de-DE" : "en-US"
}

/** HTML-tabel met de orderregels + totalen. Hergebruikt over meerdere mails. */
export function renderOrderTable(
  items: OrderLine[],
  totals: OrderTotals,
  currency: string,
  locale: Locale
): string {
  const t = TABLE_LABELS[locale]
  const rows = items
    .map(
      (i) => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid ${COLORS.line};font-family:Helvetica,Arial,sans-serif;font-size:14px;color:${COLORS.text};">
        ${escapeHtml(i.title)}${i.subtitle ? `<br/><span style="color:${COLORS.muted};font-size:12px;">${escapeHtml(i.subtitle)}</span>` : ""}
        <span style="color:${COLORS.muted};"> &times; ${i.quantity}</span>
      </td>
      <td align="right" style="padding:12px 0;border-bottom:1px solid ${COLORS.line};font-family:Helvetica,Arial,sans-serif;font-size:14px;color:${COLORS.text};white-space:nowrap;">
        ${money(i.unit_price * i.quantity, currency, locale)}
      </td>
    </tr>`
    )
    .join("")

  const totalRow = (label: string, value: string, bold = false) => `
    <tr>
      <td style="padding:6px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:${bold ? COLORS.text : COLORS.muted};${bold ? "font-weight:700;padding-top:12px;" : ""}">${label}</td>
      <td align="right" style="padding:6px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:${COLORS.text};${bold ? "font-weight:700;padding-top:12px;" : ""}white-space:nowrap;">${value}</td>
    </tr>`

  const discountLabel = totals.promo_code
    ? `${t.discount} (${escapeHtml(totals.promo_code.toUpperCase())})`
    : t.discount

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
    ${rows}
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
    ${totalRow(t.subtotal, money(totals.subtotal, currency, locale))}
    ${(totals.discount ?? 0) > 0 ? totalRow(discountLabel, `&minus;${money(totals.discount!, currency, locale)}`) : ""}
    ${totalRow(t.shipping, totals.shipping > 0 ? money(totals.shipping, currency, locale) : t.free)}
    ${totals.tax > 0 ? totalRow(t.tax, money(totals.tax, currency, locale)) : ""}
    ${totalRow(t.total, money(totals.total, currency, locale), true)}
  </table>`
}

export function renderAddress(addr: ShippingAddress): string {
  const name = [addr.first_name, addr.last_name].filter(Boolean).join(" ")
  const parts = [
    name,
    addr.address_1,
    [addr.postal_code, addr.city].filter(Boolean).join(" "),
    addr.country_code?.toUpperCase(),
    addr.phone ? `Tel: ${addr.phone}` : null,
  ].filter(Boolean)
  return parts.map((p) => escapeHtml(String(p))).join("<br/>")
}

const TABLE_LABELS: Record<Locale, Record<string, string>> = {
  nl: { subtotal: "Subtotaal", discount: "Korting", shipping: "Verzending", tax: "Waarvan btw", total: "Totaal", free: "Gratis" },
  en: { subtotal: "Subtotal", discount: "Discount", shipping: "Shipping", tax: "Incl. VAT", total: "Total", free: "Free" },
  de: { subtotal: "Zwischensumme", discount: "Rabatt", shipping: "Versand", tax: "Inkl. MwSt.", total: "Gesamt", free: "Kostenlos" },
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}
