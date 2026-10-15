-- Esquema de auditoría en D1 (SQLite). Ya aplicado en la base
-- agente-factura-sii el 15-10-2026 junto con los datos migrados desde Supabase.
-- Equivalente al esquema Postgres original; las funciones RPC crear_factura y
-- registrar_transicion viven ahora en el Worker (src/index.ts) como batches.
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
CREATE TABLE IF NOT EXISTS solicitudes_facturas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  texto TEXT NOT NULL,
  factura_id TEXT,
  error TEXT,
  procesado_en TEXT,
  estado TEXT NOT NULL DEFAULT 'NUEVA',
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_state_events_factura ON state_events(factura_id);
CREATE INDEX IF NOT EXISTS idx_email_attempts_factura ON email_attempts(factura_id);
CREATE INDEX IF NOT EXISTS idx_solicitudes_estado ON solicitudes_facturas(estado);
CREATE INDEX IF NOT EXISTS idx_invoice_runs_estado ON invoice_runs(estado);
CREATE VIEW IF NOT EXISTS facturas_aprobadas_pendientes AS
  SELECT r.factura_id FROM invoice_runs r JOIN approvals a USING (factura_id)
  WHERE r.estado = 'PENDIENTE_APROBACION' AND a.payload_hash = r.payload_hash;
