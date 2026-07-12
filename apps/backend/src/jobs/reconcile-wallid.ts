import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { completeCartWorkflow } from "@medusajs/medusa/core-flows";

/**
 * Terugkerende Wallid-afstemming (vangnet voor "betaald maar geen order").
 *
 * Draait op de productie-backend en is onafhankelijk van de Wallid-webhook: het
 * pollt zelf de Wallid-status van elke niet-afgeronde Wallid-cart en rondt bij
 * SUCCESS de cart af. Daardoor ontstaat de order en vuurt order.placed
 * (bevestigingsmail naar klant + admin) — ook als de webhook niets levert of de
 * klant niet terugkeert op de bedankpagina.
 *
 * Idempotent: afgeronde carts worden overgeslagen.
 */
export default async function reconcileWallidJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const apiUrl = process.env.WALLID_API_URL;
  const keyId = process.env.WALLID_KEY_ID;
  const keySecret = process.env.WALLID_KEY_SECRET;
  if (!apiUrl || !keyId || !keySecret) return;

  const auth = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const statusOf = async (apiPaymentId: string): Promise<string | null> => {
    try {
      const r = await fetch(
        `${apiUrl.replace(/\/$/, "")}/status?apiPaymentId=${encodeURIComponent(apiPaymentId)}`,
        { headers: { Authorization: auth } }
      );
      if (!r.ok) return null;
      return (await r.json())?.status ?? null;
    } catch {
      return null;
    }
  };

  const { data: carts } = await query.graph({
    entity: "cart",
    fields: [
      "id",
      "completed_at",
      "payment_collection.payment_sessions.provider_id",
      "payment_collection.payment_sessions.data",
    ],
  });

  const candidates = (carts as any[]).filter((c) => {
    if (c.completed_at) return false;
    const sessions = c.payment_collection?.payment_sessions ?? [];
    return sessions.some((s: any) => String(s.provider_id).includes("wallid"));
  });
  if (!candidates.length) return;

  for (const c of candidates) {
    const session = (c.payment_collection?.payment_sessions ?? []).find((s: any) =>
      String(s.provider_id).includes("wallid")
    );
    const apiId = session?.data?.api_payment_id;
    if (!apiId) continue;
    const status = await statusOf(String(apiId));
    if (status !== "SUCCESS") continue;
    try {
      const { result } = await completeCartWorkflow(container).run({ input: { id: c.id } });
      logger.info(`[wallid-reconcile] order hersteld uit cart ${c.id}: ${(result as any)?.id}`);
    } catch (e: any) {
      logger.error(`[wallid-reconcile] afronden mislukt voor cart ${c.id}: ${e?.message}`);
    }
  }
}

export const config = {
  name: "reconcile-wallid-payments",
  // Elke 3 minuten: een klant die betaalt heeft binnen enkele minuten zijn order
  // + bevestigingsmail, ook als de webhook niets doet.
  schedule: "*/3 * * * *",
};
