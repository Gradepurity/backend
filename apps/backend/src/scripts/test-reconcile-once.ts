import { ExecArgs } from "@medusajs/framework/types";
import reconcileWallidJob from "../jobs/reconcile-wallid";

/**
 * Draai de reconcile-wallid job eenmalig handmatig (zelfde code als de cron).
 * Read-only in effect zolang er geen betaalde-maar-onafgeronde carts zijn.
 */
export default async function testReconcileOnce({ container }: ExecArgs) {
  const logger = container.resolve("logger");
  logger.info("[test-reconcile] start handmatige run…");
  await reconcileWallidJob(container as any);
  logger.info("[test-reconcile] klaar.");
}
