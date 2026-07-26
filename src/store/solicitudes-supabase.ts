// src/store/solicitudes-supabase.ts
// Solicitudes de factura puntual (Telegram) persistidas en Supabase por la
// Edge Function telegram-webhook. Solo existen en modo nube.
import type { SupabaseClient } from '@supabase/supabase-js';

export interface SolicitudFactura {
  id: number;
  chat_id: string;
  texto: string;
}

export interface RepoSolicitudes {
  pendientes(): Promise<SolicitudFactura[]>;
  marcarProcesada(id: number, facturaId: string): Promise<void>;
  marcarRechazada(id: number, error: string): Promise<void>;
}

export class SolicitudesSupabase implements RepoSolicitudes {
  constructor(private readonly sb: SupabaseClient) {}

  private lanzar(operacion: string, error: { message: string }): never {
    throw new Error(`Supabase solicitudes ${operacion}: ${error.message}`);
  }

  async pendientes(): Promise<SolicitudFactura[]> {
    const { data, error } = await this.sb
      .from('solicitudes_facturas')
      .select('id, chat_id, texto')
      .eq('estado', 'NUEVA')
      .order('id');
    if (error) this.lanzar('pendientes', error);
    return (data ?? []) as SolicitudFactura[];
  }

  async marcarProcesada(id: number, facturaId: string): Promise<void> {
    const { error } = await this.sb
      .from('solicitudes_facturas')
      .update({ estado: 'PROCESADA', factura_id: facturaId, procesado_en: new Date().toISOString() })
      .eq('id', id);
    if (error) this.lanzar('marcarProcesada', error);
  }

  async marcarRechazada(id: number, mensaje: string): Promise<void> {
    const { error } = await this.sb
      .from('solicitudes_facturas')
      .update({ estado: 'RECHAZADA', error: mensaje, procesado_en: new Date().toISOString() })
      .eq('id', id);
    if (error) this.lanzar('marcarRechazada', error);
  }
}
