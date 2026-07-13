import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

/** READ-ONLY: toon de notification_provider-tabel (id/handle/channels/enabled). */
export default async function checkNotificationProviders({ container }: ExecArgs) {
  const logger = container.resolve("logger");
  const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
  const rows = await (pg as any)
    .select("*")
    .from("notification_provider");
  logger.info(`[providers] ${JSON.stringify(rows)}`);
}
