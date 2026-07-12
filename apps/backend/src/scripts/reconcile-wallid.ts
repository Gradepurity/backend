import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { completeCartWorkflow } from "@medusajs/medusa/core-flows";

/**
 * Wallid-afstemming: vangt "betaald maar geen order" op.
 *
 * Wallid's webhook is onbetrouwbaar (soms nooit geactiveerd), en de storefront-
 * fallback werkt alleen als de klant terugkeert op de bedankpagina. Dit script
 * loopt alle NIET-afgeronde carts met een Wallid-betaalsessie langs, vraagt bij
 * Wallid de echte status op, en rondt bij SUCCESS de cart af — waardoor de order
 * ontstaat en order.placed (bevestigingsmail klant + admin) vuurt.
 *
 * Idempotent: een al afgeronde cart wordt overgeslagen.
 *   npx medusa exec ./src/scripts/reconcile-wallid.ts
 */
export default async function reconcileWallid({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const apiUrl = process.env.WALLID_API_URL;
  const keyId = process.env.WALLID_KEY_ID;
  const keySecret = process.env.WALLID_KEY_SECRET;
  if (!apiUrl || !keyId || !keySecret) {
    logger.error("Wallid-keys ontbreken in de omgeving — kan niet afstemmen.");
    return;
  }
  const auth = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const statusOf = async (apiPaymentId: string): Promise<string | null> => {
    try {
      const r = await fetch(`${apiUrl.replace(/\/$/, "")}/status?apiPaymentId=${encodeURIComponent(apiPaymentId)}`, {
        headers: { Authorization: auth },
      });
      if (!r.ok) return null;
      return (await r.json())?.status ?? null;
    } catch {
      return null;
    }
  };

  // Alle carts met hun betaalsessies; filter client-side op niet-afgerond + Wallid.
  const { data: carts } = await query.graph({
    entity: "cart",
    fields: [
      "id",
      "email",
      "completed_at",
      "payment_collection.payment_sessions.provider_id",
      "payment_collection.payment_sessions.status",
      "payment_collection.payment_sessions.data",
    ],
  });

  const candidates = (carts as any[]).filter((c) => {
    if (c.completed_at) return false;
    const sessions = c.payment_collection?.payment_sessions ?? [];
    return sessions.some((s: any) => String(s.provider_id).includes("wallid"));
  });

  logger.info(`\n===== ${candidates.length} niet-afgeronde Wallid-cart(s) om te checken =====`);
  let recovered = 0;
  for (const c of candidates) {
    const session = (c.payment_collection?.payment_sessions ?? []).find((s: any) =>
      String(s.provider_id).includes("wallid")
    );
    const apiId = session?.data?.api_payment_id;
    if (!apiId) {
      logger.info(`  cart ${c.id}: geen api_payment_id, sla over`);
      continue;
    }
    const status = await statusOf(String(apiId));
    logger.info(`  cart ${c.id} (${c.email ?? "?"}) → Wallid=${status ?? "onbekend"}`);
    if (status !== "SUCCESS") continue;

    try {
      const { result } = await completeCartWorkflow(container).run({ input: { id: c.id } });
      logger.info(`    ✅ ORDER AANGEMAAKT: ${(result as any)?.id ?? "?"} — bevestigingsmail vuurt via order.placed`);
      recovered++;
    } catch (e: any) {
      logger.error(`    ❌ afronden mislukt voor cart ${c.id}: ${e?.message}`);
    }
  }
  logger.info(`\n===== KLAAR — ${recovered} order(s) hersteld =====\n`);
}
