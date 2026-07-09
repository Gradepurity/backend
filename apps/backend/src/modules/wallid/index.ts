import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import WallidProviderService from "./service"

export default ModuleProvider(Modules.PAYMENT, {
  services: [WallidProviderService],
})
