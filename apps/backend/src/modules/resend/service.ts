import { AbstractNotificationProviderService, MedusaError } from "@medusajs/framework/utils"
import {
  Logger,
  ProviderSendNotificationDTO,
  ProviderSendNotificationResultsDTO,
} from "@medusajs/framework/types"
import { Resend } from "resend"
import { render, TemplateId, OrderEmailData } from "./templates"

export type ResendOptions = {
  /** Resend API-key (re_...). */
  api_key: string
  /** Afzender, bijv. "GradePurity <orders@gradepurity.com>". */
  from: string
  /** Optioneel Reply-To, bijv. info@gradepurity.com. */
  reply_to?: string
}

type InjectedDependencies = {
  logger: Logger
}

/**
 * Resend notification-provider voor Medusa v2.
 *
 * Verstuurt transactionele e-mail (orderbevestiging, betaling ontvangen,
 * verzonden) via Resend. De HTML komt uit ./templates op basis van het
 * `template`-veld dat de subscriber meegeeft.
 *
 * Registreer in medusa-config onder het notification-module met id "resend"
 * en channel "email".
 */
export default class ResendNotificationProviderService extends AbstractNotificationProviderService {
  static identifier = "resend"

  private resend: Resend
  private options: ResendOptions
  private logger: Logger

  constructor({ logger }: InjectedDependencies, options: ResendOptions) {
    super()
    this.logger = logger
    this.options = options
    this.resend = new Resend(options.api_key)
  }

  static validateOptions(options: Record<string, unknown>) {
    if (!options.api_key) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Resend notification provider vereist `api_key`."
      )
    }
    if (!options.from) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Resend notification provider vereist `from`."
      )
    }
  }

  async send(
    notification: ProviderSendNotificationDTO
  ): Promise<ProviderSendNotificationResultsDTO> {
    if (!notification.to) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Geen ontvanger (`to`) opgegeven voor de e-mail."
      )
    }

    const { subject, html } = render(
      notification.template as TemplateId,
      (notification.data ?? {}) as unknown as OrderEmailData
    )

    let { data, error } = await this.resend.emails.send({
      from: this.options.from,
      to: [notification.to],
      subject,
      html,
      ...(this.options.reply_to ? { replyTo: this.options.reply_to } : {}),
    })

    // Resend limiteert op 2 req/sec; de klant- en admin-mail van dezelfde order
    // gaan direct na elkaar de deur uit. Bij een rate-limit even wachten en één
    // keer opnieuw proberen in plaats van de admin-mail stil te laten vallen.
    if (error && /rate.?limit|too many/i.test(`${error.name} ${error.message}`)) {
      this.logger.warn(
        `Resend rate-limit bij ${notification.template} naar ${notification.to} — retry over 1,2s.`
      )
      await new Promise((r) => setTimeout(r, 1200))
      ;({ data, error } = await this.resend.emails.send({
        from: this.options.from,
        to: [notification.to],
        subject,
        html,
        ...(this.options.reply_to ? { replyTo: this.options.reply_to } : {}),
      }))
    }

    if (error) {
      this.logger.error(
        `Resend kon e-mail (${notification.template}) niet versturen naar ${notification.to}: ${error.message}`
      )
      throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, error.message)
    }

    this.logger.info(
      `Resend e-mail (${notification.template}) verstuurd naar ${notification.to} (id: ${data?.id})`
    )
    return { id: data?.id }
  }
}
