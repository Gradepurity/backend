import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";

/**
 * Reset het wachtwoord van een bestaande admin-user (emailpass-provider).
 *
 * Gebruik:
 *   npx medusa exec ./src/scripts/reset-admin-password.ts <email> <nieuw-wachtwoord>
 */
export default async function resetAdminPassword({
  container,
  args,
}: {
  container: MedusaContainer;
  args: string[];
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const auth = container.resolve(Modules.AUTH);

  const [email, password] = args ?? [];
  if (!email || !password) {
    logger.error(
      "Gebruik: medusa exec ./src/scripts/reset-admin-password.ts <email> <wachtwoord>"
    );
    return;
  }

  const result = await auth.updateProvider("emailpass", {
    entity_id: email,
    password,
  });

  if (!result.success) {
    logger.error(`Reset mislukt: ${result.error ?? "onbekende fout"}`);
    return;
  }
  logger.info(`Wachtwoord voor ${email} is gereset. ✅`);
}
