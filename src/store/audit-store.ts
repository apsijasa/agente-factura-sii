// src/store/audit-store.ts
import Database from 'better-sqlite3';
import { assertTransicion } from '../domain/maquina-estados.js';
import type { Estado, InvoicePayload, LineaFactura } from '../domain/tipos.js';

export interface FilaFactura {
  factura_id: string;
  estado: Estado;
  payload_json: string;
  payload_hash: string;
  folio_sii: string | null;
  pdf_path: string | null;
}

export interface EventoEstado {
  factura_id: string;
  desde: Estado | null;
  hacia: Estado;
  detalle: string;
  creado_en: string;
}

export class AuditStore {
  private readonly db: Database.Database;

  constructor(ruta: string) {
    this.db = new Database(ruta);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS invoice_runs (
        factura_id TEXT PRIMARY KEY,
        estado TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        folio_sii TEXT,
        pdf_path TEXT,
        creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS invoice_lines (
        factura_id TEXT NOT NULL REFERENCES invoice_runs(factura_id),
        cobro_id TEXT NOT NULL,
        descripcion TEXT NOT NULL,
        moneda TEXT NOT NULL,
        monto_neto_original REAL NOT NULL,
        cantidad REAL NOT NULL,
        precio_unitario_clp INTEGER NOT NULL,
        total_linea_clp INTEGER NOT NULL,
        PRIMARY KEY (factura_id, cobro_id)
      );
      CREATE TABLE IF NOT EXISTS state_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        factura_id TEXT NOT NULL,
        desde TEXT,
        hacia TEXT NOT NULL,
        detalle TEXT NOT NULL,
        creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS approvals (
        factura_id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        aprobado_en TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS email_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        factura_id TEXT NOT NULL,
        exito INTEGER NOT NULL,
        detalle TEXT NOT NULL,
        creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
  }

  crearFactura(payload: InvoicePayload, payloadHash: string): void {
    const existe = this.obtenerFactura(payload.factura_id);
    if (existe) throw new Error(`La factura ${payload.factura_id} ya existe (idempotencia)`);
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO invoice_runs (factura_id, estado, payload_json, payload_hash)
           VALUES (?, 'BORRADOR', ?, ?)`,
        )
        .run(payload.factura_id, JSON.stringify(payload), payloadHash);
      const insLinea = this.db.prepare(
        `INSERT INTO invoice_lines
         (factura_id, cobro_id, descripcion, moneda, monto_neto_original, cantidad, precio_unitario_clp, total_linea_clp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const l of payload.lineas) {
        insLinea.run(
          payload.factura_id, l.cobro_id, l.descripcion, l.moneda,
          l.monto_neto_original, l.cantidad, l.precio_unitario_clp, l.total_linea_clp,
        );
      }
      this.db
        .prepare(`INSERT INTO state_events (factura_id, desde, hacia, detalle) VALUES (?, NULL, 'BORRADOR', 'creación')`)
        .run(payload.factura_id);
    });
    try {
      tx();
    } catch (error) {
      // Respaldo de la PK: si otro proceso insertó la fila entre el pre-chequeo
      // y el INSERT, se normaliza al mismo error amistoso de idempotencia.
      if (error instanceof Error && /UNIQUE constraint failed: invoice_runs\.factura_id/.test(error.message)) {
        throw new Error(`La factura ${payload.factura_id} ya existe (idempotencia)`);
      }
      throw error;
    }
  }

  obtenerFactura(facturaId: string): FilaFactura | undefined {
    return this.db.prepare('SELECT * FROM invoice_runs WHERE factura_id = ?').get(facturaId) as
      | FilaFactura
      | undefined;
  }

  obtenerLineas(facturaId: string): LineaFactura[] {
    return this.db
      .prepare('SELECT * FROM invoice_lines WHERE factura_id = ? ORDER BY cobro_id')
      .all(facturaId) as LineaFactura[];
  }

  registrarTransicion(facturaId: string, hacia: Estado, detalle: string): void {
    const actual = this.obtenerFactura(facturaId);
    if (!actual) throw new Error(`Factura no encontrada: ${facturaId}`);
    assertTransicion(actual.estado, hacia);
    const tx = this.db.transaction(() => {
      // Compare-and-swap: solo actualiza si el estado sigue siendo el leído.
      const result = this.db
        .prepare('UPDATE invoice_runs SET estado = ? WHERE factura_id = ? AND estado = ?')
        .run(hacia, facturaId, actual.estado);
      if (result.changes !== 1) {
        throw new Error(
          `Transición rechazada: el estado cambió de forma concurrente (se leyó ${actual.estado} para ${facturaId})`,
        );
      }
      this.db
        .prepare('INSERT INTO state_events (factura_id, desde, hacia, detalle) VALUES (?, ?, ?, ?)')
        .run(facturaId, actual.estado, hacia, detalle);
    });
    tx();
  }

  obtenerEventos(facturaId: string): EventoEstado[] {
    return this.db
      .prepare('SELECT * FROM state_events WHERE factura_id = ? ORDER BY id')
      .all(facturaId) as EventoEstado[];
  }

  registrarAprobacion(facturaId: string, actor: string, payloadHash: string, aprobadoEn: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO approvals (factura_id, actor, payload_hash, aprobado_en) VALUES (?, ?, ?, ?)')
      .run(facturaId, actor, payloadHash, aprobadoEn);
  }

  obtenerAprobacion(facturaId: string): { actor: string; payload_hash: string; aprobado_en: string } | undefined {
    return this.db.prepare('SELECT actor, payload_hash, aprobado_en FROM approvals WHERE factura_id = ?').get(facturaId) as
      | { actor: string; payload_hash: string; aprobado_en: string }
      | undefined;
  }

  registrarIntentoCorreo(facturaId: string, exito: boolean, detalle: string): void {
    this.db
      .prepare('INSERT INTO email_attempts (factura_id, exito, detalle) VALUES (?, ?, ?)')
      .run(facturaId, exito ? 1 : 0, detalle);
  }

  obtenerIntentosCorreo(facturaId: string): { exito: number; detalle: string }[] {
    return this.db
      .prepare('SELECT exito, detalle FROM email_attempts WHERE factura_id = ? ORDER BY id')
      .all(facturaId) as { exito: number; detalle: string }[];
  }

  guardarFolio(facturaId: string, folio: string): void {
    this.db.prepare('UPDATE invoice_runs SET folio_sii = ? WHERE factura_id = ?').run(folio, facturaId);
  }

  guardarRutaPdf(facturaId: string, ruta: string): void {
    this.db.prepare('UPDATE invoice_runs SET pdf_path = ? WHERE factura_id = ?').run(ruta, facturaId);
  }

  cerrar(): void {
    this.db.close();
  }
}
