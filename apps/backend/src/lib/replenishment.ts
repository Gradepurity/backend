// Herbestel-herinnering ("voorraad bijna op?"): rekent per verzonden order uit
// wanneer de voorraad van de bestelde peptiden vermoedelijk op raakt, en
// selecteert welke orders een herinneringsmail moeten krijgen.
//
// Spelregels (bewust conservatief, om nooit spammy te zijn):
//  - maximaal 1 herinnering per order (metadata.replenish_reminder_sent_at);
//  - alleen de NIEUWSTE order per e-mailadres komt in aanmerking — elke nieuwe
//    bestelling vervangt de herinnering van de vorige;
//  - pas vanaf MIN_DAYS na verzending, en nooit later dan sendAt + STALE_GRACE
//    (een maanden-oude order krijgt dus nooit alsnog een late herinnering);
//  - alleen producten waarvan we een doseerprofiel hebben (accessoires,
//    bac water e.d. tellen niet mee).

import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { ReplenishEmailData } from "../modules/resend/templates"
import { Locale } from "../modules/resend/templates/layout"

// ── Doseerprofielen ───────────────────────────────────────────────────────────
// DUAL-SOURCE: spiegel van forma/src/lib/peptide-doses.ts (de rekentool).
// Bij wijziging dáár ook hier bijwerken (zelfde afspraak als bij staffelkorting).

export interface PeptideDose {
  /** Typische dosis per toediening, in mg. */
  doseMg: number
  /** Gangbare bandbreedte per toediening, in mg. */
  minMg: number
  maxMg: number
  /** Frequentie-prefill. */
  freq: number
  freqPeriod: "day" | "week"
}

/** Keyed op product-handle (= slug in forma/src/lib/data.ts). */
export const PEPTIDE_DOSES: Record<string, PeptideDose> = {
  // ─── GH-secretagogen + IGF (µg-schaal) ───
  "cjc-1295-no-dac": { doseMg: 0.1, minMg: 0.1, maxMg: 0.3, freq: 2, freqPeriod: "day" },
  ipamorelin: { doseMg: 0.1, minMg: 0.1, maxMg: 0.3, freq: 2, freqPeriod: "day" },
  "ghrp-2": { doseMg: 0.1, minMg: 0.1, maxMg: 0.3, freq: 2, freqPeriod: "day" },
  "ghrp-6": { doseMg: 0.1, minMg: 0.1, maxMg: 0.3, freq: 3, freqPeriod: "day" },
  "igf-1-lr3": { doseMg: 0.04, minMg: 0.02, maxMg: 0.12, freq: 1, freqPeriod: "day" },
  tesamorelin: { doseMg: 2, minMg: 1.28, maxMg: 2, freq: 1, freqPeriod: "day" },

  // ─── Herstel / mitochondriaal / cosmetisch injecteerbaar ───
  "bpc-157": { doseMg: 0.25, minMg: 0.2, maxMg: 0.5, freq: 2, freqPeriod: "day" },
  "tb-500": { doseMg: 2.5, minMg: 2, maxMg: 2.5, freq: 2, freqPeriod: "week" },
  "ss-31": { doseMg: 5, minMg: 5, maxMg: 10, freq: 1, freqPeriod: "day" },
  "mots-c": { doseMg: 5, minMg: 2.5, maxMg: 10, freq: 3, freqPeriod: "week" },
  epitalon: { doseMg: 10, minMg: 2, maxMg: 10, freq: 1, freqPeriod: "day" },
  "melanotan-2": { doseMg: 0.25, minMg: 0.25, maxMg: 1, freq: 1, freqPeriod: "day" },
  "nad-plus": { doseMg: 100, minMg: 50, maxMg: 150, freq: 3, freqPeriod: "week" },
  "ghk-cu": { doseMg: 2, minMg: 1, maxMg: 2, freq: 1, freqPeriod: "day" },

  // ─── Focus / voortplanting ───
  selank: { doseMg: 0.3, minMg: 0.2, maxMg: 0.4, freq: 2, freqPeriod: "day" },
  semax: { doseMg: 0.3, minMg: 0.2, maxMg: 0.6, freq: 1, freqPeriod: "day" },
  "pt-141": { doseMg: 1.75, minMg: 1.25, maxMg: 2, freq: 2, freqPeriod: "week" },
  gonadorelin: { doseMg: 0.1, minMg: 0.05, maxMg: 0.25, freq: 3, freqPeriod: "week" },

  // ─── GLP-1 / metabool (mg-schaal, 1×/week, opgetitreerd) ───
  retatrutide: { doseMg: 1, minMg: 1, maxMg: 12, freq: 1, freqPeriod: "week" },
  tirzepatide: { doseMg: 2.5, minMg: 2.5, maxMg: 15, freq: 1, freqPeriod: "week" },
  semaglutide: { doseMg: 0.25, minMg: 0.25, maxMg: 2.4, freq: 1, freqPeriod: "week" },
  survodutide: { doseMg: 0.3, minMg: 0.3, maxMg: 4.8, freq: 1, freqPeriod: "week" },
  cagrilintide: { doseMg: 0.3, minMg: 0.3, maxMg: 4.5, freq: 1, freqPeriod: "week" },

  // ─── Vetstofwisseling (mcg-schaal, dagelijks) ───
  aod9604: { doseMg: 0.3, minMg: 0.25, maxMg: 0.5, freq: 1, freqPeriod: "day" },

  // ─── Immuun (mg-schaal, 2×/week) ───
  "thymosin-alpha-1": { doseMg: 1.6, minMg: 1.6, maxMg: 3.2, freq: 2, freqPeriod: "week" },

  // ─── Ontsteking (mcg-schaal, dagelijks) ───
  kpv: { doseMg: 0.5, minMg: 0.2, maxMg: 0.5, freq: 1, freqPeriod: "day" },

  // ─── GH-as (mcg-schaal, dagelijks voor de nacht) ───
  sermorelin: { doseMg: 0.3, minMg: 0.2, maxMg: 0.5, freq: 1, freqPeriod: "day" },
  "cjc-1295-ipamorelin": { doseMg: 0.2, minMg: 0.1, maxMg: 0.3, freq: 1, freqPeriod: "day" },

  // ─── Herstel-blend (totale blend-mg per injectie, dagelijks) ───
  klow: { doseMg: 4, minMg: 2, maxMg: 8, freq: 1, freqPeriod: "day" },
}

/**
 * Alleen voor de herinnering, NIET in de rekentool (daar bewust uitgesloten
 * als multi-component combo): injecteerbare bundel-vials, gedoseerd op de
 * totale blend-massa per injectie.
 */
const BUNDLE_DOSES: Record<string, PeptideDose> = {
  // BPC-157 + TB-500 blend-vial (helft/helft), dagelijks ~0,5 mg blend.
  "bpc-157-tb-500": { doseMg: 0.5, minMg: 0.25, maxMg: 1, freq: 1, freqPeriod: "day" },
  // CagriSema voorgemengd, 1×/week, opgetitreerd zoals de losse GLP-1's.
  cagrisema: { doseMg: 0.5, minMg: 0.5, maxMg: 4.8, freq: 1, freqPeriod: "week" },
}

/** Volledige lookup voor de herinnering: rekentool-spiegel + bundel-extra's. */
const DOSES: Record<string, PeptideDose> = { ...PEPTIDE_DOSES, ...BUNDLE_DOSES }

// ── Instellingen ──────────────────────────────────────────────────────────────

/**
 * Per-product override: aantal dagen na verzending waarop de herinnering
 * verstuurd wordt, ongeacht vialgrootte/aantal. Wint van de berekening.
 * Handle → dagen. Voorbeeld: { retatrutide: 45 }.
 */
export const REPLENISH_OVERRIDE_DAYS: Record<string, number> = {}

/**
 * Klanten die geen voorraadherinneringen willen (reply op de mail volstaat om
 * hier te belanden). Kleine lijst in code = geen extra opslag nodig.
 */
export const REPLENISH_OPT_OUT: string[] = []

/** Herinner bij ~80% van de geschatte voorraadduur (vóórdat het op is). */
const REMINDER_FRACTION = 0.8
/** Nooit eerder dan 3 weken na verzending (niet pushy vlak na levering). */
const MIN_DAYS = 21
/** Nooit later dan 90 dagen na verzending (daarna is de schatting waardeloos). */
const MAX_DAYS = 90
/** Venster waarin een verschuldigde herinnering nog verstuurd wordt. */
const STALE_GRACE_DAYS = 21
/** Verzending → in huis (PostNL NL/BE/DE). */
const TRANSIT_DAYS = 2
/** Producten die binnen dit venster ná het eerste product ook opraken, komen mee in dezelfde mail. */
const BUNDLE_WINDOW_DAYS = 14

const SITE_URL = "https://gradepurity.com"

// ── Berekening per product ────────────────────────────────────────────────────

/** "10 mg vial" / "0,5 mg" → mg-getal, of null als het niet te parsen is. */
export function parseVialMg(variantTitle?: string | null): number | null {
  if (!variantTitle) return null
  const m = /(\d+(?:[.,]\d+)?)\s*mg/i.exec(variantTitle)
  if (!m) return null
  const mg = parseFloat(m[1].replace(",", "."))
  return Number.isFinite(mg) && mg > 0 ? mg : null
}

/**
 * Geschatte voorraadduur in dagen voor `qty` vials van `vialMg` mg.
 * Voor sterk optitrerende producten (max ≥ 4× startdosis, de GLP-1's) rekenen
 * we met het midden van de bandbreedte i.p.v. de startdosis — anders zou een
 * vial op papier maanden meegaan terwijl de klant allang hoger zit.
 */
export function supplyDays(handle: string, vialMg: number, qty: number): number | null {
  const dose = DOSES[handle]
  if (!dose || vialMg <= 0 || qty <= 0) return null
  const titrated = dose.maxMg / dose.doseMg >= 4
  const perShotMg = titrated ? (dose.minMg + dose.maxMg) / 2 : dose.doseMg
  const dailyMg = perShotMg * (dose.freqPeriod === "day" ? dose.freq : dose.freq / 7)
  if (dailyMg <= 0) return null
  return (vialMg * qty) / dailyMg
}

/**
 * Dagen ná verzending waarop de herinnering voor dit orderitem hoort te vallen,
 * of null als het product geen doseerprofiel heeft of de vial niet te parsen is.
 */
export function reminderDaysForItem(
  handle: string,
  variantTitle: string | null | undefined,
  qty: number
): number | null {
  const override = REPLENISH_OVERRIDE_DAYS[handle]
  if (override != null) return override
  if (!DOSES[handle]) return null
  const vialMg = parseVialMg(variantTitle)
  if (vialMg == null) return null
  const days = supplyDays(handle, vialMg, qty)
  if (days == null) return null
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.round(days * REMINDER_FRACTION)))
}

// ── Orderselectie ─────────────────────────────────────────────────────────────

export type ReplenishItem = {
  handle: string
  title: string
  variant: string | null
  quantity: number
  /** Dagen na verzending waarop dít item aan een herinnering toe is. */
  reminderDays: number
}

export type CandidateStatus =
  | "due" // nu versturen
  | "future" // gepland, sendAt ligt in de toekomst
  | "stale" // venster gemist — nooit meer versturen
  | "sent" // al verstuurd (metadata-vlag)
  | "superseded" // klant heeft een nieuwere order — die telt
  | "opted-out" // klant wil geen herinneringen
  | "no-peptides" // geen items met doseerprofiel
  | "not-shipped" // (nog) niet verzonden

export type ReplenishCandidate = {
  orderId: string
  displayId: number | string
  email: string
  locale: Locale
  metadata: Record<string, unknown>
  shippedAt: Date | null
  /** Geplande verzenddatum van de herinnering (shippedAt + transit + dagen). */
  sendAt: Date | null
  status: CandidateStatus
  /** Alle items met doseerprofiel. */
  items: ReplenishItem[]
  /** Items die in de mail komen (opraken rond hetzelfde moment als het eerste). */
  dueItems: ReplenishItem[]
}

function localeForCountry(cc?: string | null): Locale {
  const c = cc?.toLowerCase()
  if (c === "de" || c === "at") return "de"
  if (c === "nl" || c === "be") return "nl"
  if (c === "fr") return "fr"
  return c ? "en" : "nl"
}

/**
 * Haalt alle orders op en bepaalt per order de herinnering-status.
 * Read-only; het daadwerkelijke versturen doet sendReplenishReminder.
 */
export async function collectReplenishCandidates(
  container: MedusaContainer
): Promise<ReplenishCandidate[]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  // Let op: géén totalen/prijzen opvragen — de lijst-query crasht in 2.15 op
  // orders met shipping-adjustments zodra totalen berekend worden (zie
  // order-email.ts). Namen + aantallen (items.detail.quantity) zijn genoeg.
  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "email",
      "status",
      "created_at",
      "metadata",
      "shipping_address.country_code",
      "items.product_handle",
      "items.product_title",
      "items.title",
      "items.variant_title",
      "items.detail.quantity",
      "fulfillments.shipped_at",
      "fulfillments.canceled_at",
    ],
    pagination: { take: 1000, skip: 0 } as any,
  })

  const active = (orders as any[]).filter((o) => o.status !== "canceled" && o.email)

  // Nieuwste order per e-mailadres wint; alle oudere zijn superseded.
  const newestByEmail = new Map<string, string>()
  for (const o of active) {
    const key = String(o.email).toLowerCase()
    const cur = newestByEmail.get(key)
    if (!cur) {
      newestByEmail.set(key, o.id)
      continue
    }
    const curOrder = active.find((x) => x.id === cur)
    if (String(o.created_at) > String(curOrder?.created_at ?? "")) {
      newestByEmail.set(key, o.id)
    }
  }

  const now = Date.now()
  const optOut = new Set(REPLENISH_OPT_OUT.map((e) => e.toLowerCase()))

  return active.map((o): ReplenishCandidate => {
    const email = String(o.email).toLowerCase()
    const metadata = (o.metadata ?? {}) as Record<string, unknown>

    // Voorraad start bij de éérste verzending (deel-leveringen: vroegste telt).
    const shippedDates = (o.fulfillments ?? [])
      .filter((f: any) => !f.canceled_at && f.shipped_at)
      .map((f: any) => new Date(f.shipped_at).getTime())
      .filter((t: number) => Number.isFinite(t))
    const shippedAt = shippedDates.length ? new Date(Math.min(...shippedDates)) : null

    const items: ReplenishItem[] = (o.items ?? [])
      .map((it: any): ReplenishItem | null => {
        const handle = it.product_handle
        if (!handle) return null
        const qty = Math.round(Number(it.detail?.quantity ?? it.quantity ?? 1)) || 1
        const days = reminderDaysForItem(handle, it.variant_title, qty)
        if (days == null) return null
        return {
          handle,
          title: it.product_title ?? it.title ?? handle,
          variant: it.variant_title ?? null,
          quantity: qty,
          reminderDays: days,
        }
      })
      .filter(Boolean) as ReplenishItem[]

    const base: Omit<ReplenishCandidate, "status" | "sendAt" | "dueItems"> = {
      orderId: o.id,
      displayId: o.display_id ?? o.id,
      email,
      locale: localeForCountry(o.shipping_address?.country_code),
      metadata,
      shippedAt,
      items,
    }

    const done = (status: CandidateStatus, sendAt: Date | null = null, dueItems: ReplenishItem[] = []) => ({
      ...base,
      status,
      sendAt,
      dueItems,
    })

    if (metadata.replenish_reminder_sent_at) return done("sent")
    if (optOut.has(email)) return done("opted-out")
    if (!items.length) return done("no-peptides")
    if (newestByEmail.get(email) !== o.id) return done("superseded")
    if (!shippedAt) return done("not-shipped")

    const minDays = Math.min(...items.map((i) => i.reminderDays))
    const sendAt = new Date(shippedAt.getTime() + (minDays + TRANSIT_DAYS) * 24 * 60 * 60 * 1000)
    const dueItems = items.filter((i) => i.reminderDays <= minDays + BUNDLE_WINDOW_DAYS)

    if (now < sendAt.getTime()) return done("future", sendAt, dueItems)
    if (now > sendAt.getTime() + STALE_GRACE_DAYS * 24 * 60 * 60 * 1000) {
      return done("stale", sendAt, dueItems)
    }
    return done("due", sendAt, dueItems)
  })
}

// ── Versturen ─────────────────────────────────────────────────────────────────

/**
 * Verstuurt de herinneringsmail voor één kandidaat en zet de metadata-vlag,
 * zodat dezelfde order nooit twee keer gemaild wordt.
 */
export async function sendReplenishReminder(
  container: MedusaContainer,
  cand: ReplenishCandidate
): Promise<void> {
  const data: ReplenishEmailData = {
    locale: cand.locale,
    display_id: cand.displayId,
    reorder_items: cand.dueItems.map((i) => ({
      title: i.title,
      subtitle: i.variant,
      // Canonieke NL-slug werkt in elke taal: /de|/en 308't naar de eigen slug.
      url: `${SITE_URL}/${cand.locale}/product/${i.handle}`,
    })),
  }

  const notifications = container.resolve(Modules.NOTIFICATION)
  await notifications.createNotifications({
    to: cand.email,
    channel: "email",
    template: "replenish-reminder",
    data: data as unknown as Record<string, unknown>,
  })

  // Vlag pas ná succesvol versturen zetten; merge met bestaande metadata
  // (updateOrders vervangt het object, dus cadeaus e.d. moeten mee).
  const orderModule = container.resolve(Modules.ORDER)
  await orderModule.updateOrders([
    {
      id: cand.orderId,
      metadata: {
        ...cand.metadata,
        replenish_reminder_sent_at: new Date().toISOString(),
        replenish_reminder_products: cand.dueItems.map((i) => i.handle).join(", "),
      },
    },
  ])
}
