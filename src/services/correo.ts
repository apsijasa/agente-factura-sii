// src/services/correo.ts
import type { IGraphClient } from '../adapters/graph/graph-client.js';

// Límite del MVP para adjuntos en línea de Graph sendMail; las sesiones de carga quedan fuera de alcance.
const MAX_ADJUNTO_BYTES = 3 * 1024 * 1024;

export interface EnvioFactura {
  remitente: string;
  destinatarios: string[];
  copia: string[];
  asunto: string;
  cuerpo: string;
  // El adjunto viaja en memoria: en la nube el PDF viene del bucket, no del disco.
  nombreAdjunto: string;
  pdf: Buffer;
}

export class MailService {
  constructor(
    private readonly graph: IGraphClient,
    private readonly buzonPrincipal: string,
  ) {}

  async enviarFactura(envio: EnvioFactura): Promise<void> {
    const datos = envio.pdf;
    if (!datos.subarray(0, 5).toString('latin1').startsWith('%PDF')) {
      throw new Error(`El adjunto no es un PDF válido: ${envio.nombreAdjunto}`);
    }
    if (datos.length > MAX_ADJUNTO_BYTES) {
      throw new Error(
        `El adjunto supera el máximo de ${MAX_ADJUNTO_BYTES} bytes: ` +
          `${envio.nombreAdjunto} tiene ${datos.length} bytes`,
      );
    }
    const aDireccion = (correo: string) => ({ emailAddress: { address: correo } });
    await this.graph.solicitar('POST', `/users/${this.buzonPrincipal}/sendMail`, {
      message: {
        subject: envio.asunto,
        body: { contentType: 'Text', content: envio.cuerpo },
        from: aDireccion(envio.remitente),
        toRecipients: envio.destinatarios.map(aDireccion),
        ccRecipients: envio.copia.map(aDireccion),
        attachments: [
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: envio.nombreAdjunto,
            contentType: 'application/pdf',
            contentBytes: datos.toString('base64'),
          },
        ],
      },
      saveToSentItems: true,
    });
  }
}
