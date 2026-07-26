// src/services/notificador.ts
import type { IGraphClient } from '../adapters/graph/graph-client.js';

/** Canal por el que llega la solicitud de aprobación remota al operador. */
export interface CanalNotificacion {
  enviar(mensaje: string): Promise<void>;
}

export interface ConfigWhatsApp {
  token: string;
  phoneId: string;
  para: string;
}

const WHATSAPP_API = 'https://graph.facebook.com/v20.0';

export class NotificadorWhatsApp implements CanalNotificacion {
  constructor(
    private readonly cfg: ConfigWhatsApp,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async enviar(mensaje: string): Promise<void> {
    const respuesta = await this.fetchFn(`${WHATSAPP_API}/${this.cfg.phoneId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: this.cfg.para,
        type: 'text',
        text: { body: mensaje },
      }),
    });
    if (!respuesta.ok) {
      const detalle = await respuesta.text();
      // El detalle de Meta no incluye el token; se recorta por si acaso.
      throw new Error(`WhatsApp Cloud API respondió ${respuesta.status}: ${detalle.slice(0, 200)}`);
    }
  }
}

export interface ConfigTelegram {
  token: string;
  chatId: string;
}

const TELEGRAM_API = 'https://api.telegram.org';

export class NotificadorTelegram implements CanalNotificacion {
  constructor(
    private readonly cfg: ConfigTelegram,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async enviar(mensaje: string): Promise<void> {
    const respuesta = await this.fetchFn(`${TELEGRAM_API}/bot${this.cfg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.cfg.chatId,
        text: mensaje,
        // Sin vista previa del enlace: el resumen de la factura es lo importante.
        link_preview_options: { is_disabled: true },
      }),
    });
    if (!respuesta.ok) {
      const detalle = await respuesta.text();
      // Jamás incluir la URL en el error: contiene el token del bot.
      throw new Error(`Telegram Bot API respondió ${respuesta.status}: ${detalle.slice(0, 200)}`);
    }
  }
}

export class NotificadorCorreo implements CanalNotificacion {
  constructor(
    private readonly graph: IGraphClient,
    private readonly buzonPrincipal: string,
  ) {}

  async enviar(mensaje: string): Promise<void> {
    await this.graph.solicitar('POST', `/users/${this.buzonPrincipal}/sendMail`, {
      message: {
        subject: 'Factura pendiente de aprobación — agente SII',
        body: { contentType: 'Text', content: mensaje },
        toRecipients: [{ emailAddress: { address: this.buzonPrincipal } }],
      },
      saveToSentItems: false,
    });
  }
}

/**
 * Prioridad de canales: Telegram (el más simple de configurar), luego
 * WhatsApp, y si no hay ninguno, correo al buzón principal — siempre existe
 * un canal disponible.
 */
export function crearNotificador(
  env: Record<string, string | undefined>,
  graph: IGraphClient,
  buzonPrincipal: string,
): CanalNotificacion {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_TO } = env;
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    return new NotificadorTelegram({ token: TELEGRAM_BOT_TOKEN, chatId: TELEGRAM_CHAT_ID });
  }
  if (WHATSAPP_TOKEN && WHATSAPP_PHONE_ID && WHATSAPP_TO) {
    return new NotificadorWhatsApp({ token: WHATSAPP_TOKEN, phoneId: WHATSAPP_PHONE_ID, para: WHATSAPP_TO });
  }
  return new NotificadorCorreo(graph, buzonPrincipal);
}
