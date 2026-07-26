// tests/store/audit-store-contrato.test.ts
// Suite de CONTRATO: el mismo comportamiento observable, ejecutado contra las
// dos implementaciones de IAuditStore (SQLite local y Supabase). Si una regla
// cambia en una implementación y no en la otra, esta suite lo delata.
// Hallazgo graphify 2026-07-26: ambos stores son gemelos estructurales sin un
// contrato común que impida que diverjan en silencio.
import { describe, expect, it } from 'vitest';
import { AuditStore, type IAuditStore } from '../../src/store/audit-store.js';
import { AuditStoreSupabase } from '../../src/store/audit-store-supabase.js';
import { crearSupabaseFalso } from './supabase-falso.js';
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

const implementaciones: [string, () => IAuditStore][] = [
  ['AuditStore (SQLite)', () => new AuditStore(':memory:')],
  ['AuditStoreSupabase', () => new AuditStoreSupabase(crearSupabaseFalso().sb)],
];

describe.each(implementaciones)('Contrato IAuditStore — %s', (_nombre, crearStore) => {
  it('crea la factura en BORRADOR con sus líneas y evento de creación', async () => {
    const store = crearStore();
    await store.crearFactura(payload, 'hash-abc');
    const f = await store.obtenerFactura(payload.factura_id);
    expect(f?.estado).toBe('BORRADOR');
    expect(f?.payload_hash).toBe('hash-abc');
    expect(f?.payload_json).toBe(JSON.stringify(payload));
    expect(await store.obtenerLineas(payload.factura_id)).toHaveLength(1);
    const eventos = await store.obtenerEventos(payload.factura_id);
    expect(eventos.map((e) => e.hacia)).toEqual(['BORRADOR']);
  });

  it('rechaza duplicados de la misma clave con el mismo error amistoso', async () => {
    const store = crearStore();
    await store.crearFactura(payload, 'hash-abc');
    await expect(store.crearFactura(payload, 'hash-abc')).rejects.toThrow(/ya existe \(idempotencia\)/);
  });

  it('registra transiciones válidas con su evento, en orden', async () => {
    const store = crearStore();
    await store.crearFactura(payload, 'h');
    await store.registrarTransicion(payload.factura_id, 'PENDIENTE_APROBACION', 'preparada');
    await store.registrarTransicion(payload.factura_id, 'CANCELADA', 'motivo');
    expect((await store.obtenerFactura(payload.factura_id))?.estado).toBe('CANCELADA');
    const eventos = await store.obtenerEventos(payload.factura_id);
    expect(eventos.map((e) => e.hacia)).toEqual(['BORRADOR', 'PENDIENTE_APROBACION', 'CANCELADA']);
    expect(eventos.at(-1)?.detalle).toBe('motivo');
  });

  it('rechaza transiciones prohibidas SIN registrar evento ni cambiar estado', async () => {
    const store = crearStore();
    await store.crearFactura(payload, 'h');
    await expect(store.registrarTransicion(payload.factura_id, 'EMITIDA', 'salto')).rejects.toThrow(
      /Transición prohibida/,
    );
    expect((await store.obtenerFactura(payload.factura_id))?.estado).toBe('BORRADOR');
    expect(await store.obtenerEventos(payload.factura_id)).toHaveLength(1);
  });

  it('rechaza transicionar una factura inexistente', async () => {
    const store = crearStore();
    await expect(store.registrarTransicion('NO-EXISTE', 'CANCELADA', 'x')).rejects.toThrow(
      /Factura no encontrada/,
    );
  });

  it('la aprobación se reemplaza (upsert), no se acumula', async () => {
    const store = crearStore();
    await store.crearFactura(payload, 'h');
    await store.registrarAprobacion(payload.factura_id, 'andres', 'hash-1', '2026-07-01T00:00:00Z');
    await store.registrarAprobacion(payload.factura_id, 'aprobacion-remota', 'hash-2', '2026-07-02T00:00:00Z');
    const a = await store.obtenerAprobacion(payload.factura_id);
    expect(a?.actor).toBe('aprobacion-remota');
    expect(a?.payload_hash).toBe('hash-2');
  });

  it('obtenerAprobacion devuelve undefined cuando no hay aprobación', async () => {
    const store = crearStore();
    expect(await store.obtenerAprobacion('SIN-APROBACION')).toBeUndefined();
  });

  it('los intentos de correo se acumulan con exito como entero 1/0', async () => {
    const store = crearStore();
    await store.crearFactura(payload, 'h');
    await store.registrarIntentoCorreo(payload.factura_id, false, 'alias rechazado');
    await store.registrarIntentoCorreo(payload.factura_id, true, 'enviado');
    const intentos = await store.obtenerIntentosCorreo(payload.factura_id);
    expect(intentos.map((i) => i.exito)).toEqual([0, 1]);
    expect(intentos.map((i) => i.detalle)).toEqual(['alias rechazado', 'enviado']);
  });

  it('guarda folio y ruta del PDF sin tocar el estado', async () => {
    const store = crearStore();
    await store.crearFactura(payload, 'h');
    await store.guardarFolio(payload.factura_id, '99');
    await store.guardarRutaPdf(payload.factura_id, 'ruta/Factura_99.pdf');
    const f = await store.obtenerFactura(payload.factura_id);
    expect(f?.folio_sii).toBe('99');
    expect(f?.pdf_path).toBe('ruta/Factura_99.pdf');
    expect(f?.estado).toBe('BORRADOR');
  });

  it('marcarEmisionesInterrumpidas fuerza EMITIENDO→REQUIERE_REVISION y no toca otras', async () => {
    const store = crearStore();
    await store.crearFactura(payload, 'h');
    await store.registrarTransicion(payload.factura_id, 'PENDIENTE_APROBACION', 't');
    await store.registrarTransicion(payload.factura_id, 'APROBADA', 't');
    await store.registrarTransicion(payload.factura_id, 'EMITIENDO', 't');
    const otra = { ...payload, factura_id: 'RECURRENT:E1:CL2:2026-07' };
    await store.crearFactura(otra, 'h2');

    const interrumpidas = await store.marcarEmisionesInterrumpidas();

    expect(interrumpidas).toEqual([payload.factura_id]);
    expect((await store.obtenerFactura(payload.factura_id))?.estado).toBe('REQUIERE_REVISION');
    expect((await store.obtenerFactura(otra.factura_id))?.estado).toBe('BORRADOR');
    expect((await store.obtenerEventos(payload.factura_id)).at(-1)?.detalle).toMatch(/interrumpida/i);
  });

  it('listarFacturaIds devuelve todas las facturas ordenadas', async () => {
    const store = crearStore();
    const b = { ...payload, factura_id: 'RECURRENT:E1:CLB:2026-07' };
    const a = { ...payload, factura_id: 'RECURRENT:E1:CLA:2026-07' };
    await store.crearFactura(b, 'h1');
    await store.crearFactura(a, 'h2');
    expect(await store.listarFacturaIds()).toEqual([a.factura_id, b.factura_id]);
  });

  it('obtenerFactura devuelve undefined para una clave inexistente', async () => {
    const store = crearStore();
    expect(await store.obtenerFactura('NO-EXISTE')).toBeUndefined();
  });
});
