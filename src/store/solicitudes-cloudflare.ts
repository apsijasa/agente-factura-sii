// src/store/solicitudes-cloudflare.ts
// Solicitudes de factura puntual (Telegram) persistidas en D1 por el Worker
// (/telegram-webhook). Solo existen en modo nube.
import type { ApiCloudflare } from './api-cloudflare.js';
import type { RepoSolicitudes, SolicitudFactura } from './solicitudes-supabase.js';

export class SolicitudesCloudflare implements RepoSolicitudes {
  constructor(private readonly api: ApiCloudflare) {}

  async pendientes(): Promise<SolicitudFactura[]> {
    const { results } = await this.api.query<SolicitudFactura>(
      "SELECT id, chat_id, texto FROM solicitudes_facturas WHERE estado = 'NUEVA' ORDER BY id",
    );
    return results;
  }

  async marcarProcesada(id: number, facturaId: string): Promise<void> {
    await this.api.query(
      "UPDATE solicitudes_facturas SET estado = 'PROCESADA', factura_id = ?, procesado_en = ? WHERE id = ?",
      [facturaId, new Date().toISOString(), id],
    );
  }

  async marcarRechazada(id: number, mensaje: string): Promise<void> {
    await this.api.query(
      "UPDATE solicitudes_facturas SET estado = 'RECHAZADA', error = ?, procesado_en = ? WHERE id = ?",
      [mensaje, new Date().toISOString(), id],
    );
  }
}
