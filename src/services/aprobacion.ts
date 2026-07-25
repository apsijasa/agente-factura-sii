// src/services/aprobacion.ts
import { hashPayload } from '../domain/hash.js';
import { ocultarRut } from '../domain/rut.js';
import type { InvoicePayload } from '../domain/tipos.js';
import type { IAuditStore } from '../store/audit-store.js';

export interface IoAprobacion {
  pregunta(mensaje: string): Promise<string>;
}

export interface ResultadoAprobacion {
  aprobada: boolean;
  hash: string;
  actor: string;
  fecha: string;
}

/**
 * Fuente de la aprobación humana: interactiva (terminal local) o remota
 * (registrada de antemano vía enlace firmado). Ambas garantizan que nada se
 * emite sin decisión explícita del operador.
 */
export interface IAprobacion {
  solicitarAprobacion(payload: InvoicePayload, rutaPrevista: string): Promise<ResultadoAprobacion>;
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

export class ApprovalService implements IAprobacion {
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

/**
 * Aprobación remota asíncrona: el operador ya aprobó desde su teléfono (la
 * Edge Function `aprobar` validó el token firmado y registró la fila en
 * `approvals`). Aquí solo se verifica que esa aprobación exista y siga
 * ligada al contenido exacto de la factura; nunca se aprueba en caliente.
 */
export class AprobacionRemota implements IAprobacion {
  constructor(private readonly store: IAuditStore) {}

  async solicitarAprobacion(payload: InvoicePayload): Promise<ResultadoAprobacion> {
    const hash = hashPayload(payload);
    const registrada = await this.store.obtenerAprobacion(payload.factura_id);
    if (!registrada || registrada.payload_hash !== hash) {
      return { aprobada: false, hash, actor: registrada?.actor ?? '', fecha: registrada?.aprobado_en ?? '' };
    }
    return { aprobada: true, hash, actor: registrada.actor, fecha: registrada.aprobado_en };
  }
}
