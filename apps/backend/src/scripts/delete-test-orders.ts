import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { cancelOrderWorkflow } from "@medusajs/medusa/core-flows";

/**
 * Verwijder testorders: eerst annuleren (geeft reserveringen vrij), daarna
 * soft-delete zodat ze uit admin, boekhouding en queries verdwijnen.
 * Weigert orders met verzending of gecapturede betaling; met "force" wordt
 * alleen de betaal-check overgeslagen (voor test-captures zonder echt geld).
 * ("force" zonder streepjes: de Medusa-CLI eist --flags voor zichzelf op.)
 *   npx medusa exec ./src/scripts/delete-test-orders.ts [force] <display_id> [<display_id> ...]
 */
export default async function deleteTestOrders({ container, args }: ExecArgs) {
  const logger = container.resolve("logger");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const orderModule = container.resolve(Modules.ORDER);

  const force = (args ?? []).includes("force");
  const displayIds = (args ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!displayIds.length) {
    logger.error("Gebruik: medusa exec ./src/scripts/delete-test-orders.ts <display_id> ...");
    return;
  }

  for (const displayId of displayIds) {
    const { data: orders } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "display_id",
        "email",
        "status",
        "fulfillments.id",
        "fulfillments.shipped_at",
        "fulfillments.canceled_at",
        "payment_collections.payments.captured_at",
      ],
      filters: { display_id: displayId as unknown as string },
    });

    const order = (orders as any[])[0];
    if (!order) {
      logger.warn(`#${displayId}: niet gevonden (al verwijderd?) — overslaan`);
      continue;
    }

    const shipped = (order.fulfillments ?? []).some((f: any) => !f.canceled_at && f.shipped_at);
    const captured = (order.payment_collections ?? [])
      .flatMap((pc: any) => pc.payments ?? [])
      .some((p: any) => p.captured_at);
    if (shipped) {
      logger.error(`#${displayId} (${order.email}): verzonden — dit lijkt geen testorder, overslaan`);
      continue;
    }
    if (captured && !force) {
      logger.error(
        `#${displayId} (${order.email}): betaald — dit lijkt geen testorder, overslaan ("force" om te forceren)`
      );
      continue;
    }

    if (order.status !== "canceled") {
      try {
        await cancelOrderWorkflow(container).run({ input: { order_id: order.id } });
        logger.info(`#${displayId} (${order.email}): geannuleerd`);
      } catch (e: any) {
        logger.warn(`#${displayId}: annuleren faalde (${e?.message}) — toch soft-deleten`);
      }
    }

    await orderModule.softDeleteOrders([order.id]);
    logger.info(`#${displayId} (${order.email}): soft-deleted`);
  }

  logger.info("Klaar.");
}
