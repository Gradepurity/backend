import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Koppelt een gast-order aan het ingelogde klant-account (post-purchase claim).
 *
 * Gast-checkout laat orders aan een "guest customer"-record hangen; wie na de
 * bestelling op de bevestigingspagina een wachtwoord kiest, krijgt via deze
 * route de order alsnog in "mijn bestellingen". Alleen toegestaan als het
 * e-mailadres van de order exact overeenkomt met dat van het account —
 * de klant kan dus uitsluitend z'n eigen orders claimen.
 *
 * POST /store/orders/claim  { order_id }  (authenticated customer, zie middlewares.ts)
 */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const customerId = req.auth_context?.actor_id
  if (!customerId) {
    res.status(401).json({ message: "Niet ingelogd." })
    return
  }

  const orderId = String((req.body as { order_id?: string })?.order_id ?? "")
  if (!orderId.startsWith("order_")) {
    res.status(400).json({ message: "order_id ontbreekt of is ongeldig." })
    return
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const { data: customers } = await query.graph({
    entity: "customer",
    fields: ["id", "email"],
    filters: { id: customerId },
  })
  const customer = customers[0]
  if (!customer?.email) {
    res.status(404).json({ message: "Klant niet gevonden." })
    return
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["id", "email", "customer_id"],
    filters: { id: orderId },
  })
  const order = orders[0]
  if (!order) {
    res.status(404).json({ message: "Order niet gevonden." })
    return
  }

  if (order.customer_id === customerId) {
    res.json({ ok: true, already: true })
    return
  }

  if ((order.email ?? "").toLowerCase() !== customer.email.toLowerCase()) {
    res.status(403).json({ message: "Deze order hoort niet bij dit e-mailadres." })
    return
  }

  const orderModule = req.scope.resolve(Modules.ORDER)
  await orderModule.updateOrders([{ id: orderId, customer_id: customerId }])

  res.json({ ok: true })
}
