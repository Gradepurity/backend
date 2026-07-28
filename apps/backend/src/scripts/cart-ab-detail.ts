import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

/**
 * READ-ONLY: volledige adres/contactgegevens van één cart.
 *   npx medusa exec ./src/scripts/cart-ab-detail.ts
 */
export default async function cartAbDetail({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const { data: carts } = await query.graph({
    entity: "cart",
    fields: [
      "id",
      "email",
      "created_at",
      "updated_at",
      "shipping_address.first_name",
      "shipping_address.last_name",
      "shipping_address.address_1",
      "shipping_address.address_2",
      "shipping_address.postal_code",
      "shipping_address.city",
      "shipping_address.country_code",
      "shipping_address.phone",
      "billing_address.first_name",
      "billing_address.last_name",
      "billing_address.address_1",
      "billing_address.postal_code",
      "billing_address.city",
      "billing_address.country_code",
      "shipping_methods.name",
      "shipping_methods.amount",
      "total",
      "item_total",
      "shipping_total",
    ],
    filters: { id: "cart_01KYJQEXZ63406HM5G1FHFZ311" },
  });

  logger.info(JSON.stringify(carts, null, 2));
}
