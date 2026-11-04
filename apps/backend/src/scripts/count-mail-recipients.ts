import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

/**
 * Read-only: unieke e-mailadressen uit orders + klantaccounts, per land/taal.
 *   npx medusa exec ./src/scripts/count-mail-recipients.ts
 */
export default async function countMailRecipients({ container }: ExecArgs) {
  const logger = container.resolve("logger");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["display_id", "email", "status", "created_at", "shipping_address.country_code", "metadata"],
  });
  const { data: customers } = await query.graph({
    entity: "customer",
    fields: ["email", "has_account", "created_at", "metadata"],
  });

  const byEmail = new Map<string, { country: string; orders: number; statuses: Set<string>; locale?: string }>();
  for (const o of orders as any[]) {
    const e = (o.email ?? "").trim().toLowerCase();
    if (!e) continue;
    const cur = byEmail.get(e) ?? { country: "", orders: 0, statuses: new Set<string>() };
    cur.orders++;
    cur.statuses.add(o.status);
    cur.country = (o.shipping_address?.country_code ?? cur.country ?? "").toUpperCase();
    if (o.metadata?.locale) cur.locale = o.metadata.locale;
    byEmail.set(e, cur);
  }
  let accountOnly = 0;
  for (const c of customers as any[]) {
    const e = (c.email ?? "").trim().toLowerCase();
    if (!e || byEmail.has(e)) continue;
    accountOnly++;
    byEmail.set(e, { country: "?", orders: 0, statuses: new Set(["(alleen account/klantrecord)"]) });
  }

  const perCountry: Record<string, number> = {};
  const perLocale: Record<string, number> = {};
  for (const v of byEmail.values()) {
    perCountry[v.country || "?"] = (perCountry[v.country || "?"] ?? 0) + 1;
    perLocale[v.locale ?? "onbekend"] = (perLocale[v.locale ?? "onbekend"] ?? 0) + 1;
  }
  const onlyCanceled = [...byEmail.values()].filter((v) => v.orders > 0 && [...v.statuses].every((s) => s === "canceled")).length;

  logger.info(`\n===== ONTVANGERS =====`);
  logger.info(`Orders totaal: ${orders.length} | klantrecords: ${customers.length}`);
  logger.info(`Unieke e-mails: ${byEmail.size} (waarvan ${accountOnly} zonder order, ${onlyCanceled} met alleen geannuleerde orders)`);
  logger.info(`Per land: ${JSON.stringify(perCountry)}`);
  logger.info(`Per order-locale (metadata): ${JSON.stringify(perLocale)}`);
  logger.info(`Domeinen eigen/test: ${[...byEmail.keys()].filter((e) => /webreaktor|gradepurity|example|test/.test(e)).join(", ")}`);
  logger.info(`===== EIND =====`);
}
