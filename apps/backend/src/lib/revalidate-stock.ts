/**
 * Ping de storefront om de voorraad-cache direct door te spoelen
 * (POST /api/revalidate-stock, zie forma/src/app/api/revalidate-stock).
 * Aangeroepen door de stock-changed-subscriber en de set-stock-scripts.
 *
 * Mag nooit een voorraad-update of order breken: fouten worden gelogd,
 * niet gegooid. De storefront heeft sowieso een 60s-vangnet.
 */
export async function pingStockRevalidate(
  logger?: { info: (m: string) => void; warn: (m: string) => void }
): Promise<void> {
  const base = process.env.STOREFRONT_URL || "https://gradepurity.com"
  const url = `${base.replace(/\/$/, "")}/api/revalidate-stock`
  const secret = process.env.REVALIDATE_STOCK_SECRET

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: secret ? { "x-revalidate-secret": secret } : {},
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) {
      logger?.info(`storefront voorraad-cache doorgespoeld (${url})`)
    } else {
      logger?.warn(`voorraad-revalidate ping gaf HTTP ${res.status} (${url})`)
    }
  } catch (e) {
    logger?.warn(
      `voorraad-revalidate ping mislukt: ${e instanceof Error ? e.message : String(e)}`
    )
  }
}
