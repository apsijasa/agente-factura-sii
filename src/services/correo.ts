// src/services/correo.ts
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { IGraphClient } from '../adapters/graph/graph-client.js';

// Límite del MVP para adjuntos en línea de Graph sendMail; las sesiones de carga quedan fuera de alcance.
const MAX_ADJUNTO_BYTES = 3 * 1024 * 1024;

export interface EnvioFactura {
  remitente: string;
  destinatarios: string[];
  copia: string[];
  asunto: string;
  cuerpo: string;
  rutaPdf: string;
}

export class MailService {
  constructor(
    private readonly graph: IGraphClient,
    private readonly buzonPrincipal: string,
  ) {}

  async enviarFactura(envio: EnvioFactura): Promise<void> {
    const datos = await readFile(envio.rutaPdf);
    if (!datos.subarray(0, 5).toString('latin1').startsWith('%PDF')) {
      throw new Error(`El adjunto no es un PDF válido: ${envio.rutaPdf}`);
    }
    if (datos.length > MAX_ADJUNTO_BYTES) {
      throw new Error(
        `El adjunto supera el máximo de ${MAX_ADJUNTO_BYTES} bytes: ` +
          `${envio.rutaPdf} tiene ${datos.length} bytes`,
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
            name: basename(envio.rutaPdf),
            contentType: 'application/pdf',
            contentBytes: datos.toString('base64'),
          },
        ],
      },
      saveToSentItems: true,
    });
  }
}
