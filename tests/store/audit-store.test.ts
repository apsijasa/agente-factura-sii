// tests/store/audit-store.test.ts
import { describe, expect, it, vi } from 'vitest';
import { AuditStore } from '../../src/store/audit-store.js';
import type { InvoicePayload } from '../../src/domain/tipos.js';

const payload = {
  factura_id: 'RECURRENT:E1:CL1:2026-07',
  empresa_id: 'E1',
  rut_emisor: '12345678-5',
  razon_social_emisor: 'Emisora SpA',
  cliente_id: 'CL1',
  rut_cliente: '11111111-1',
  razon_social_cliente: 'Cliente Ltda',
  nombre_carpeta: 'NCA',
  giro_cliente: 'Servicios',
  direccion_cliente: 'Calle 1',
  comuna_cliente: 'Providencia',
  ciudad_cliente: 'Santiago',
  periodo: '2026-07',
  fecha_emision: '2026-07-05',
  fecha_vencimiento: '2026-07-05',
  forma_pago: 'CONTADO',
  tipo_venta: 'Del Giro',
  tipo_compra: 'Del Giro',
  valor_uf: null,
  lineas: [
    {
      cobro_id: 'C1',
      descripcion: 'Servicio',
      moneda: 'CLP',
      monto_neto_original: 100000,
      cantidad: 1,
      precio_unitario_clp: 100000,
      total_linea_clp: 100000,
    },
  ],
  neto_clp: 100000,
  iva_clp: 19000,
  total_clp: 119000,
  remitente: 'facturas@empresa.cl',
  destinatarios: ['pagos@cliente.cl'],
  copia: ['copia@empresa.cl'],
} satisfies InvoicePayload;

function crearStore(): AuditStore {
  return new AuditStore(':memory:');
}

describe('AuditStore', () => {
  it('crea la factura en BORRADOR con sus líneas', () => {
    const store = crearStore();
    store.crearFactura(payload, 'hash-abc');
    const f = store.obtenerFactura(payload.factura_id);
    expect(f?.estado).toBe('BORRADOR');
    expect(f?.payload_hash).toBe('hash-abc');
    expect(store.obtenerLineas(payload.factura_id)).toHaveLength(1);
  });

  it('rechaza duplicados de la misma clave (idempotencia)', () => {
    const store = crearStore();
    store.crearFactura(payload, 'hash-abc');
    expect(() => store.crearFactura(payload, 'hash-abc')).toThrow(/existe/i);
  });

  it('registra transiciones válidas y las persiste en state_events', () => {
    const store = crearStore();
    store.crearFactura(payload, 'hash-abc');
    store.registrarTransicion(payload.factura_id, 'PENDIENTE_APROBACION', 'preparación completa');
    expect(store.obtenerFactura(payload.factura_id)?.estado).toBe('PENDIENTE_APROBACION');
    const eventos = store.obtenerEventos(payload.factura_id);
    expect(eventos.map((e) => e.hacia)).toEqual(['BORRADOR', 'PENDIENTE_APROBACION']);
  });

  it('rechaza transiciones inválidas', () => {
    const store = crearStore();
    store.crearFactura(payload, 'hash-abc');
    expect(() => store.registrarTransicion(payload.factura_id, 'EMITIDA', 'salto')).toThrow(
      /Transición prohibida/,
    );
  });

  it('registra aprobaciones e intentos de correo', () => {
    const store = crearStore();
    store.crearFactura(payload, 'hash-abc');
    store.registrarAprobacion(payload.factura_id, 'andres', 'hash-abc', '2026-07-05T10:00:00Z');
    store.registrarIntentoCorreo(payload.factura_id, false, 'alias rechazado');
    expect(store.obtenerAprobacion(payload.factura_id)?.actor).toBe('andres');
    expect(store.obtenerIntentosCorreo(payload.factura_id)).toHaveLength(1);
  });

  it('rechaza la transición si el estado cambió de forma concurrente (CAS)', () => {
    const store = crearStore();
    store.crearFactura(payload, 'hash-abc');
    const filaObsoleta = store.obtenerFactura(payload.factura_id);
    if (!filaObsoleta) throw new Error('fila no encontrada');
    // Otro proceso cambia el estado directamente en la base de datos.
    const db = (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
    db.prepare('UPDATE invoice_runs SET estado = ? WHERE factura_id = ?').run('CANCELADA', payload.factura_id);
    // Se fuerza la lectura obsoleta (el estado real ya es CANCELADA).
    vi.spyOn(store, 'obtenerFactura').mockReturnValueOnce(filaObsoleta);
    expect(() =>
      store.registrarTransicion(payload.factura_id, 'PENDIENTE_APROBACION', 'carrera'),
    ).toThrow(/concurrente|estado cambió/);
    // Sin evento nuevo: solo el de creación.
    expect(store.obtenerEventos(payload.factura_id)).toHaveLength(1);
  });

  it('normaliza el error de clave primaria cuando el pre-chequeo se elude (carrera)', () => {
    const store = crearStore();
    // Otro proceso inserta la fila directamente en la base de datos.
    const db = (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
    db.prepare(
      `INSERT INTO invoice_runs (factura_id, estado, payload_json, payload_hash) VALUES (?, 'BORRADOR', '{}', 'h')`,
    ).run(payload.factura_id);
    // Se simula la carrera: el pre-chequeo no ve la fila y el INSERT choca con la PK.
    vi.spyOn(store, 'obtenerFactura').mockReturnValueOnce(undefined);
    expect(() => store.crearFactura(payload, 'hash-abc')).toThrow(/existe/i);
  });

  it('marca las emisiones interrumpidas (EMITIENDO) como REQUIERE_REVISION', () => {
    const store = crearStore();
    store.crearFactura(payload, 'hash-abc');
    store.registrarTransicion(payload.factura_id, 'PENDIENTE_APROBACION', 'preparada');
    store.registrarTransicion(payload.factura_id, 'APROBADA', 'aprobada');
    store.registrarTransicion(payload.factura_id, 'EMITIENDO', 'emisión iniciada');
    // Otra factura en estado no-EMITIENDO no debe ser tocada.
    const otra = { ...payload, factura_id: 'RECURRENT:E1:CL2:2026-07' };
    store.crearFactura(otra, 'hash-otra');
    store.registrarTransicion(otra.factura_id, 'PENDIENTE_APROBACION', 'preparada');

    const interrumpidas = store.marcarEmisionesInterrumpidas();

    expect(interrumpidas).toEqual([payload.factura_id]);
    expect(store.obtenerFactura(payload.factura_id)?.estado).toBe('REQUIERE_REVISION');
    const ultimo = store.obtenerEventos(payload.factura_id).at(-1);
    expect(ultimo?.detalle).toMatch(/interrumpida/i);
    expect(store.obtenerFactura(otra.factura_id)?.estado).toBe('PENDIENTE_APROBACION');
  });

  it('marcarEmisionesInterrumpidas no hace nada si no hay filas en EMITIENDO', () => {
    const store = crearStore();
    store.crearFactura(payload, 'hash-abc');
    expect(store.marcarEmisionesInterrumpidas()).toEqual([]);
    expect(store.obtenerFactura(payload.factura_id)?.estado).toBe('BORRADOR');
  });

  it('guarda folio y ruta del PDF', () => {
    const store = crearStore();
    store.crearFactura(payload, 'hash-abc');
    store.guardarFolio(payload.factura_id, '12345');
    store.guardarRutaPdf(payload.factura_id, '/ruta/Factura_12345.pdf');
    const f = store.obtenerFactura(payload.factura_id);
    expect(f?.folio_sii).toBe('12345');
    expect(f?.pdf_path).toBe('/ruta/Factura_12345.pdf');
  });
});
