// src/store/audit-store-cloudflare.ts
import { assertTransicion } from '../domain/maquina-estados.js';
import type { Estado, InvoicePayload, LineaFactura } from '../domain/tipos.js';
import type { Aprobacion, EventoEstado, FilaFactura, IAuditStore } from './audit-store.js';
import { ErrorApiCloudflare, type ApiCloudflare } from './api-cloudflare.js';

/**
 * Almacén de auditoría contra Cloudflare D1, vía la API privada del Worker.
 * Mismas garantías que AuditStore (SQLite) y AuditStoreSupabase: crear factura
 * y transicionar estado son atómicos porque el Worker los ejecuta como un
 * batch transaccional (ex RPC crear_factura / registrar_transicion).
 * El payload viaja serializado como texto para que el hash SHA-256 de la
 * aprobación se calcule siempre sobre los mismos bytes.
 */
export class AuditStoreCloudflare implements IAuditStore {
  constructor(private readonly api: ApiCloudflare) {}

  async crearFactura(payload: InvoicePayload, payloadHash: string): Promise<void> {
    try {
      await this.api.crearFactura(JSON.stringify(payload), payloadHash);
    } catch (e) {
      if (e instanceof ErrorApiCloudflare && e.codigo === 'FACTURA_DUPLICADA') {
        throw new Error(`La factura ${payload.factura_id} ya existe (idempotencia)`);
      }
      throw e;
    }
  }

  async listarFacturaIds(): Promise<string[]> {
    const { results } = await this.api.query<{ factura_id: string }>('SELECT factura_id FROM invoice_runs ORDER BY factura_id');
    return results.map((f) => f.factura_id);
  }

  async obtenerFactura(facturaId: string): Promise<FilaFactura | undefined> {
    const { results } = await this.api.query<FilaFactura>(
      'SELECT factura_id, estado, payload_json, payload_hash, folio_sii, pdf_path FROM invoice_runs WHERE factura_id = ?',
      [facturaId],
    );
    return results[0];
  }

  async obtenerLineas(facturaId: string): Promise<LineaFactura[]> {
    const { results } = await this.api.query<LineaFactura>(
      `SELECT cobro_id, descripcion, moneda, monto_neto_original, cantidad, precio_unitario_clp, total_linea_clp
       FROM invoice_lines WHERE factura_id = ? ORDER BY cobro_id`,
      [facturaId],
    );
    return results;
  }

  async registrarTransicion(facturaId: string, hacia: Estado, detalle: string): Promise<void> {
    const actual = await this.obtenerFactura(facturaId);
    if (!actual) throw new Error(`Factura no encontrada: ${facturaId}`);
    assertTransicion(actual.estado, hacia);
    try {
      await this.api.registrarTransicion(facturaId, actual.estado, hacia, detalle);
    } catch (e) {
      if (e instanceof ErrorApiCloudflare && e.codigo === 'TRANSICION_CONCURRENTE') {
        throw new Error(
          `Transición rechazada: el estado cambió de forma concurrente (se leyó ${actual.estado} para ${facturaId})`,
        );
      }
      throw e;
    }
  }

  async obtenerEventos(facturaId: string): Promise<EventoEstado[]> {
    const { results } = await this.api.query<EventoEstado>(
      'SELECT factura_id, desde, hacia, detalle, creado_en FROM state_events WHERE factura_id = ? ORDER BY id',
      [facturaId],
    );
    return results;
  }

  async registrarAprobacion(facturaId: string, actor: string, payloadHash: string, aprobadoEn: string): Promise<void> {
    await this.api.query(
      `INSERT INTO approvals (factura_id, actor, payload_hash, aprobado_en) VALUES (?, ?, ?, ?)
       ON CONFLICT(factura_id) DO UPDATE SET actor = excluded.actor, payload_hash = excluded.payload_hash, aprobado_en = excluded.aprobado_en`,
      [facturaId, actor, payloadHash, aprobadoEn],
    );
  }

  async obtenerAprobacion(facturaId: string): Promise<Aprobacion | undefined> {
    const { results } = await this.api.query<Aprobacion>(
      'SELECT actor, payload_hash, aprobado_en FROM approvals WHERE factura_id = ?',
      [facturaId],
    );
    return results[0];
  }

  async registrarIntentoCorreo(facturaId: string, exito: boolean, detalle: string): Promise<void> {
    await this.api.query('INSERT INTO email_attempts (factura_id, exito, detalle) VALUES (?, ?, ?)', [
      facturaId,
      exito ? 1 : 0,
      detalle,
    ]);
  }

  async obtenerIntentosCorreo(facturaId: string): Promise<{ exito: number; detalle: string }[]> {
    const { results } = await this.api.query<{ exito: number; detalle: string }>(
      'SELECT exito, detalle FROM email_attempts WHERE factura_id = ? ORDER BY id',
      [facturaId],
    );
    return results;
  }

  async marcarEmisionesInterrumpidas(): Promise<string[]> {
    const { results } = await this.api.query<{ factura_id: string }>(
      "SELECT factura_id FROM invoice_runs WHERE estado = 'EMITIENDO' ORDER BY factura_id",
    );
    const ids: string[] = [];
    for (const { factura_id } of results) {
      await this.registrarTransicion(
        factura_id,
        'REQUIERE_REVISION',
        'emisión interrumpida por caída del proceso; verificar documentos emitidos en el SII antes de cualquier acción',
      );
      ids.push(factura_id);
    }
    return ids;
  }

  async guardarFolio(facturaId: string, folio: string): Promise<void> {
    await this.api.query('UPDATE invoice_runs SET folio_sii = ? WHERE factura_id = ?', [folio, facturaId]);
  }

  async guardarRutaPdf(facturaId: string, ruta: string): Promise<void> {
    await this.api.query('UPDATE invoice_runs SET pdf_path = ? WHERE factura_id = ?', [ruta, facturaId]);
  }

  async cerrar(): Promise<void> {
    // HTTP sin estado: no hay conexiones que cerrar.
  }
}
