// src/store/facturas-repository.ts
import type { ExcelAdapter, FilaFacturasExcel } from '../adapters/excel/excel-adapter.js';
import type { Estado, InvoicePayload } from '../domain/tipos.js';
import type { AuditStore } from './audit-store.js';

export function filaExcelDesdePayload(payload: InvoicePayload, estado: Estado): FilaFacturasExcel {
  return {
    factura_id: payload.factura_id,
    cobro_id: payload.lineas.map((l) => l.cobro_id).join(';'),
    periodo: payload.periodo,
    fecha_emision: payload.fecha_emision,
    valor_uf: payload.valor_uf === null ? '' : String(payload.valor_uf),
    monto_neto_clp: String(payload.neto_clp),
    iva_clp: String(payload.iva_clp),
    total_clp: String(payload.total_clp),
    folio_sii: '',
    estado,
    pdf_path: '',
    aprobada_por: '',
    fecha_aprobacion: '',
    fecha_envio: '',
    error: '',
  };
}

export class FacturasRepository {
  constructor(
    private readonly store: AuditStore,
    private readonly excel: ExcelAdapter,
  ) {}

  async registrarBorrador(payload: InvoicePayload): Promise<void> {
    await this.excel.agregarFilaFacturas(filaExcelDesdePayload(payload, 'BORRADOR'));
  }

  async reflejar(facturaId: string, cambios: Partial<FilaFacturasExcel>): Promise<void> {
    await this.excel.actualizarFilaFacturas(facturaId, cambios);
  }

  async reconciliar(): Promise<void> {
    const filas = await this.excel.leerTabla('tblFacturas');
    const porId = new Map(filas.map((f) => [f.factura_id as string, f]));

    for (const [facturaId, fila] of porId) {
      const local = this.store.obtenerFactura(facturaId);
      const folioExcel = (fila.folio_sii ?? '').trim();
      if (folioExcel && (!local || !local.folio_sii)) {
        throw new Error(
          `Contradicción: ${facturaId} tiene folio ${folioExcel} en Excel pero SQLite no registra emisión. Revisión manual requerida.`,
        );
      }
      if (folioExcel && local?.folio_sii && folioExcel !== local.folio_sii) {
        throw new Error(
          `Contradicción: ${facturaId} folio Excel=${folioExcel} difiere de SQLite=${local.folio_sii}. Revisión manual requerida.`,
        );
      }
    }

    for (const facturaId of this.store.listarFacturaIds()) {
      const local = this.store.obtenerFactura(facturaId);
      if (local?.folio_sii && !porId.has(facturaId)) {
        throw new Error(
          `Contradicción: ${facturaId} está EMITIDA en SQLite (folio ${local.folio_sii}) pero no existe en tblFacturas. Revisión manual requerida.`,
        );
      }
    }
  }
}
