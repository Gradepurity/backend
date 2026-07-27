import { MedusaContainer } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { updateRegionsWorkflow } from "@medusajs/medusa/core-flows"

/**
 * Enables the BANKpay+ provider (`pp_sepa_bankpay`) on the Europe region.
 *
 * Run AFTER the backend has booted at least once with BANKPAY_API_KEY and
 * BANKPAY_CLIENT_ID set — that boot upserts the provider into the DB. Then:
 *   npx medusa exec ./src/scripts/enable-bankpay-provider.ts
 *
 * Idempotent: keeps existing providers and adds BANKpay+ once.
 */
const BANKPAY_PROVIDER_ID = "pp_sepa_bankpay"

export default async function enableBankpayProvider({
  container,
}: {
  container: MedusaContainer
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: regions } = await query.graph({
    entity: "region",
    fields: ["id", "name", "payment_providers.id"],
  })
  const europe = regions.find((r) => r.name === "Europe") ?? regions[0]
  if (!europe) {
    throw new Error("Geen regio gevonden — draai eerst de basis-seed.")
  }

  const current = (europe.payment_providers ?? [])
    .map((p) => p?.id)
    .filter((id): id is string => Boolean(id))

  if (current.includes(BANKPAY_PROVIDER_ID)) {
    logger.info(`Regio '${europe.name}' heeft ${BANKPAY_PROVIDER_ID} al ingeschakeld.`)
    return
  }

  await updateRegionsWorkflow(container).run({
    input: {
      selector: { id: europe.id },
      update: { payment_providers: [...current, BANKPAY_PROVIDER_ID] },
    },
  })

  logger.info(
    `Regio '${europe.name}': ${BANKPAY_PROVIDER_ID} ingeschakeld. Providers nu: ${[
      ...current,
      BANKPAY_PROVIDER_ID,
    ].join(", ")} ✅`
  )
}
