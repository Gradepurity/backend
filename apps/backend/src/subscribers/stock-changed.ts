import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { InventoryEvents } from "@medusajs/framework/utils"
import { pingStockRevalidate } from "../lib/revalidate-stock"

/**
 * Voorraad of reservering gewijzigd (admin-UI, workflows, orders) -> storefront
 * pingen zodat de uitverkocht-status binnen seconden klopt. Reserveringen
 * tellen mee omdat inventory_quantity in de store-API = stocked - reserved:
 * de laatste vial die besteld wordt zet een product effectief op uitverkocht.
 */
export default async function stockChangedHandler({
  container,
}: SubscriberArgs<unknown>) {
  const logger = container.resolve("logger")
  await pingStockRevalidate(logger)
}

export const config: SubscriberConfig = {
  event: [
    InventoryEvents.INVENTORY_LEVEL_CREATED,
    InventoryEvents.INVENTORY_LEVEL_UPDATED,
    InventoryEvents.INVENTORY_LEVEL_DELETED,
    InventoryEvents.RESERVATION_ITEM_CREATED,
    InventoryEvents.RESERVATION_ITEM_UPDATED,
    InventoryEvents.RESERVATION_ITEM_DELETED,
  ],
}
