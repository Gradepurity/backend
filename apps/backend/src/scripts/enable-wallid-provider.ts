import { MedusaContainer } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { updateRegionsWorkflow } from "@medusajs/medusa/core-flows"

/**
 * Enables the Wallid provider (`pp_card_wallid`) on the Europe region.
 *
 * Run AFTER the backend has booted at least once with the WALLID_* env vars
 * set (key id + key secret + webhook secret) — that boot upserts the provider
 * into the DB. Then:
 *   npx medusa exec ./src/scripts/enable-wallid-provider.ts
 *
 * Idempotent: keeps existing providers (pp_system_default) and adds Wallid once.
 */
const WALLID_PROVIDER_ID = "pp_card_wallid"

export default async function enableWallidProvider({
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

  if (current.includes(WALLID_PROVIDER_ID)) {
    logger.info(`Regio '${europe.name}' heeft ${WALLID_PROVIDER_ID} al ingeschakeld.`)
    return
  }

  await updateRegionsWorkflow(container).run({
    input: {
      selector: { id: europe.id },
      update: { payment_providers: [...current, WALLID_PROVIDER_ID] },
    },
  })

  logger.info(
    `Regio '${europe.name}': ${WALLID_PROVIDER_ID} ingeschakeld. Providers nu: ${[
      ...current,
      WALLID_PROVIDER_ID,
    ].join(", ")} ✅`
  )
}
