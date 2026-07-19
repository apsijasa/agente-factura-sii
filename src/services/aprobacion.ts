// src/services/aprobacion.ts
import { hashPayload } from '../domain/hash.js';
import { ocultarRut } from '../domain/rut.js';
import type { InvoicePayload } from '../domain/tipos.js';

export interface IoAprobacion {
  pregunta(mensaje: string): Promise<string>;
}

export interface ResultadoAprobacion {
  aprobada: boolean;
  hash: string;
  actor: string;
  fecha: string;
}

const formatoClp = new Intl.NumberFormat('es-CL');

export function resumenAprobacion(payload: InvoicePayload, rutaPrevista: string): string {
  const lineas = payload.lineas
    .map(
      (l) =>
        `  - ${l.descripcion} | ${l.cantidad} x ${l.moneda} ${l.monto_neto_original}` +
        ` = $${formatoClp.format(l.total_linea_clp)} CLP`,
    )
    .join('\n');
  return [
    `Factura: ${payload.factura_id}`,
    `Emisor: ${payload.razon_social_emisor} (${ocultarRut(payload.rut_emisor)})`,
    `Cliente: ${payload.razon_social_cliente} (${ocultarRut(payload.rut_cliente)})`,
    `Período: ${payload.periodo} | Emisión: ${payload.fecha_emision} | Vence: ${payload.fecha_vencimiento} (${payload.forma_pago})`,
    payload.valor_uf === null ? 'UF: no aplica' : `UF del día: ${payload.valor_uf}`,
    'Líneas:',
    lineas,
    `Neto: $${formatoClp.format(payload.neto_clp)} | IVA: $${formatoClp.format(payload.iva_clp)} | Total: $${formatoClp.format(payload.total_clp)}`,
    `Remitente: ${payload.remitente}`,
    `Para: ${payload.destinatarios.join('; ')} | CC: ${payload.copia.join('; ')}`,
    `PDF previsto: ${rutaPrevista}`,
  ].join('\n');
}

export class ApprovalService {
  constructor(
    private readonly io: IoAprobacion,
    private readonly ahora: () => Date,
    private readonly actor: string,
  ) {}

  async solicitarAprobacion(payload: InvoicePayload, rutaPrevista: string): Promise<ResultadoAprobacion> {
    const hash = hashPayload(payload);
    const mensaje =
      `${resumenAprobacion(payload, rutaPrevista)}\n\n` +
      `Para aprobar escriba exactamente: APROBAR ${payload.factura_id}\n> `;
    const respuesta = (await this.io.pregunta(mensaje)).trim();
    const aprobada = respuesta === `APROBAR ${payload.factura_id}`;
    return { aprobada, hash, actor: this.actor, fecha: this.ahora().toISOString() };
  }

  hashVigente(payload: InvoicePayload, hashAprobado: string): boolean {
    return hashPayload(payload) === hashAprobado;
  }
}
