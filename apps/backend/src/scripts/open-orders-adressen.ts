import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

/**
 * Print volledige verzendadressen + betaalstatus van orders zonder fulfillment,
 * klaar om over te nemen in Mijn PostNL Zakelijk.
 *   npx medusa exec ./src/scripts/open-orders-adressen.ts
 */
export default async function openOrdersAdressen({ container }: ExecArgs) {
  const logger = container.resolve("logger");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "status",
      "email",
      "created_at",
      "shipping_address.first_name",
      "shipping_address.last_name",
      "shipping_address.company",
      "shipping_address.address_1",
      "shipping_address.address_2",
      "shipping_address.postal_code",
      "shipping_address.city",
      "shipping_address.country_code",
      "shipping_address.phone",
      "fulfillments.id",
      "fulfillments.canceled_at",
      "payment_collections.status",
      "payment_collections.payments.provider_id",
      "payment_collections.payments.captured_at",
      "items.title",
      "items.detail.quantity",
    ],
    filters: {},
    pagination: { take: 25, skip: 0, order: { display_id: "DESC" } },
  });

  for (const o of orders as any[]) {
    if (o.status === "canceled") continue;
    const hasFulfillment = (o.fulfillments ?? []).some((f: any) => !f.canceled_at);
    if (hasFulfillment) continue;

    const a = o.shipping_address ?? {};
    const pc = (o.payment_collections ?? [])[0];
    const payment = (pc?.payments ?? [])[0];
    const paid = payment?.captured_at
      ? `BETAALD (${payment.provider_id})`
      : `NIET BETAALD (${payment?.provider_id ?? "geen betaling"}, collection=${pc?.status ?? "?"})`;
    const itemsStr = (o.items ?? [])
      .map((i: any) => `${i.detail?.quantity ?? "?"}× ${i.title}`)
      .join(", ");

    logger.info(
      [
        `\n===== ORDER #${o.display_id} — ${paid} =====`,
        `Besteld: ${o.created_at}`,
        `Producten: ${itemsStr}`,
        `Naam: ${[a.first_name, a.last_name].filter(Boolean).join(" ")}${a.company ? ` (${a.company})` : ""}`,
        `Adres: ${[a.address_1, a.address_2].filter(Boolean).join(" ")}`,
        `Postcode/plaats: ${a.postal_code} ${a.city}`,
        `Land: ${(a.country_code ?? "").toUpperCase()}`,
        `E-mail: ${o.email} | Tel: ${a.phone ?? "-"}`,
      ].join("\n")
    );
  }
  logger.info("\n===== EIND =====");
}
