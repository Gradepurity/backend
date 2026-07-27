import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import BankpayProviderService from "./service"

export default ModuleProvider(Modules.PAYMENT, {
  services: [BankpayProviderService],
})
