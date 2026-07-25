// src/store/audit-store-supabase.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { assertTransicion } from '../domain/maquina-estados.js';
import type { Estado, InvoicePayload, LineaFactura } from '../domain/tipos.js';
import type { Aprobacion, EventoEstado, FilaFactura, IAuditStore } from './audit-store.js';

/**
 * Almacén de auditoría contra Supabase (Postgres). Misma estructura y las
 * mismas garantías que el AuditStore local: la creación de factura y las
 * transiciones con compare-and-swap son atómicas porque viven en funciones
 * RPC del lado del servidor (ver migración esquema_auditoria_facturas).
 * El payload viaja serializado como texto para que el hash SHA-256 de la
 * aprobación se calcule siempre sobre los mismos bytes.
 */
export class AuditStoreSupabase implements IAuditStore {
  constructor(private readonly sb: SupabaseClient) {}

  private lanzar(operacion: string, error: { message: string }): never {
    throw new Error(`Supabase ${operacion}: ${error.message}`);
  }

  async crearFactura(payload: InvoicePayload, payloadHash: string): Promise<void> {
    const { error } = await this.sb.rpc('crear_factura', {
      p_payload: JSON.stringify(payload),
      p_hash: payloadHash,
    });
    if (error) {
      if (error.message.includes('FACTURA_DUPLICADA')) {
        throw new Error(`La factura ${payload.factura_id} ya existe (idempotencia)`);
      }
      this.lanzar('crear_factura', error);
    }
  }

  async listarFacturaIds(): Promise<string[]> {
    const { data, error } = await this.sb
      .from('invoice_runs')
      .select('factura_id')
      .order('factura_id');
    if (error) this.lanzar('listarFacturaIds', error);
    return ((data ?? []) as { factura_id: string }[]).map((f) => f.factura_id);
  }

  async obtenerFactura(facturaId: string): Promise<FilaFactura | undefined> {
    const { data, error } = await this.sb
      .from('invoice_runs')
      .select('factura_id, estado, payload_json, payload_hash, folio_sii, pdf_path')
      .eq('factura_id', facturaId)
      .maybeSingle();
    if (error) this.lanzar('obtenerFactura', error);
    return (data as FilaFactura | null) ?? undefined;
  }

  async obtenerLineas(facturaId: string): Promise<LineaFactura[]> {
    const { data, error } = await this.sb
      .from('invoice_lines')
      .select('cobro_id, descripcion, moneda, monto_neto_original, cantidad, precio_unitario_clp, total_linea_clp')
      .eq('factura_id', facturaId)
      .order('cobro_id');
    if (error) this.lanzar('obtenerLineas', error);
    return (data ?? []) as LineaFactura[];
  }

  async registrarTransicion(facturaId: string, hacia: Estado, detalle: string): Promise<void> {
    const actual = await this.obtenerFactura(facturaId);
    if (!actual) throw new Error(`Factura no encontrada: ${facturaId}`);
    assertTransicion(actual.estado, hacia);
    const { error } = await this.sb.rpc('registrar_transicion', {
      p_factura_id: facturaId,
      p_desde: actual.estado,
      p_hacia: hacia,
      p_detalle: detalle,
    });
    if (error) {
      if (error.message.includes('TRANSICION_CONCURRENTE')) {
        throw new Error(
          `Transición rechazada: el estado cambió de forma concurrente (se leyó ${actual.estado} para ${facturaId})`,
        );
      }
      this.lanzar('registrar_transicion', error);
    }
  }

  async obtenerEventos(facturaId: string): Promise<EventoEstado[]> {
    const { data, error } = await this.sb
      .from('state_events')
      .select('factura_id, desde, hacia, detalle, creado_en')
      .eq('factura_id', facturaId)
      .order('id');
    if (error) this.lanzar('obtenerEventos', error);
    return (data ?? []) as EventoEstado[];
  }

  async registrarAprobacion(facturaId: string, actor: string, payloadHash: string, aprobadoEn: string): Promise<void> {
    const { error } = await this.sb.from('approvals').upsert({
      factura_id: facturaId,
      actor,
      payload_hash: payloadHash,
      aprobado_en: aprobadoEn,
    });
    if (error) this.lanzar('registrarAprobacion', error);
  }

  async obtenerAprobacion(facturaId: string): Promise<Aprobacion | undefined> {
    const { data, error } = await this.sb
      .from('approvals')
      .select('actor, payload_hash, aprobado_en')
      .eq('factura_id', facturaId)
      .maybeSingle();
    if (error) this.lanzar('obtenerAprobacion', error);
    return (data as Aprobacion | null) ?? undefined;
  }

  async registrarIntentoCorreo(facturaId: string, exito: boolean, detalle: string): Promise<void> {
    const { error } = await this.sb.from('email_attempts').insert({
      factura_id: facturaId,
      exito: exito ? 1 : 0,
      detalle,
    });
    if (error) this.lanzar('registrarIntentoCorreo', error);
  }

  async obtenerIntentosCorreo(facturaId: string): Promise<{ exito: number; detalle: string }[]> {
    const { data, error } = await this.sb
      .from('email_attempts')
      .select('exito, detalle')
      .eq('factura_id', facturaId)
      .order('id');
    if (error) this.lanzar('obtenerIntentosCorreo', error);
    return (data ?? []) as { exito: number; detalle: string }[];
  }

  async marcarEmisionesInterrumpidas(): Promise<string[]> {
    const { data, error } = await this.sb
      .from('invoice_runs')
      .select('factura_id')
      .eq('estado', 'EMITIENDO')
      .order('factura_id');
    if (error) this.lanzar('marcarEmisionesInterrumpidas', error);
    const ids: string[] = [];
    for (const { factura_id } of (data ?? []) as { factura_id: string }[]) {
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
    const { error } = await this.sb
      .from('invoice_runs')
      .update({ folio_sii: folio })
      .eq('factura_id', facturaId);
    if (error) this.lanzar('guardarFolio', error);
  }

  async guardarRutaPdf(facturaId: string, ruta: string): Promise<void> {
    const { error } = await this.sb
      .from('invoice_runs')
      .update({ pdf_path: ruta })
      .eq('factura_id', facturaId);
    if (error) this.lanzar('guardarRutaPdf', error);
  }

  async cerrar(): Promise<void> {
    // El cliente HTTP de Supabase no mantiene conexiones que cerrar.
  }
}
