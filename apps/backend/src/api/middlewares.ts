import { defineMiddlewares, authenticate } from "@medusajs/framework/http"

export default defineMiddlewares({
  routes: [
    {
      // Post-purchase order-claim vereist een ingelogde klant (bearer of sessie).
      matcher: "/store/orders/claim",
      middlewares: [authenticate("customer", ["bearer", "session"])],
    },
    {
      // Raw body bewaren voor HMAC-verificatie van de Wallid-webhook.
      matcher: "/hooks/payment/pp_card_wallid",
      method: ["POST"],
      bodyParser: { preserveRawBody: true },
    },
  ],
})
