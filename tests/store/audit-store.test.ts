// tests/store/audit-store.test.ts
import { describe, expect, it } from 'vitest';
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
