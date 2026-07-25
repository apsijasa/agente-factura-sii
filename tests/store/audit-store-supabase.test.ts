// tests/store/audit-store-supabase.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AuditStoreSupabase } from '../../src/store/audit-store-supabase.js';
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

interface Fila {
  factura_id: string;
  estado: string;
  payload_json: string;
  payload_hash: string;
  folio_sii: string | null;
  pdf_path: string | null;
}

/**
 * Cliente Supabase simulado: `consultas` define, por tabla, el resultado de la
 * consulta encadenada (select/eq/order/maybeSingle) y las escrituras quedan
 * registradas en `escrituras`.
 */
function clienteFalso(consultas: Record<string, unknown> = {}) {
  const escrituras: { tabla: string; metodo: string; args: unknown[] }[] = [];
  const rpc = vi.fn(async () => ({ error: null as { message: string } | null }));
  const from = vi.fn((tabla: string) => {
    const resultado = { data: consultas[tabla] ?? null, error: null };
    const b: Record<string, unknown> = {};
    const registrar = (metodo: string) =>
      vi.fn((...args: unknown[]) => {
        escrituras.push({ tabla, metodo, args });
        return { eq: vi.fn(async () => ({ error: null })), then: undefined, error: null };
      });
    b.select = vi.fn(() => b);
    b.eq = vi.fn(() => b);
    b.order = vi.fn(async () => resultado);
    b.maybeSingle = vi.fn(async () => resultado);
    b.upsert = registrar('upsert');
    b.insert = registrar('insert');
    b.update = registrar('update');
    return b;
  });
  return { sb: { rpc, from } as unknown as SupabaseClient, rpc, from, escrituras };
}

describe('AuditStoreSupabase', () => {
  it('crearFactura invoca la RPC con el payload serializado exacto', async () => {
    const { sb, rpc } = clienteFalso();
    const store = new AuditStoreSupabase(sb);
    await store.crearFactura(payload, 'hash-abc');
    expect(rpc).toHaveBeenCalledWith('crear_factura', {
      p_payload: JSON.stringify(payload),
      p_hash: 'hash-abc',
    });
  });

  it('mapea FACTURA_DUPLICADA al error amistoso de idempotencia', async () => {
    const { sb, rpc } = clienteFalso();
    rpc.mockResolvedValue({ error: { message: 'FACTURA_DUPLICADA' } });
    const store = new AuditStoreSupabase(sb);
    await expect(store.crearFactura(payload, 'h')).rejects.toThrow(/existe/i);
  });

  it('obtenerFactura devuelve undefined cuando no hay fila', async () => {
    const { sb } = clienteFalso({ invoice_runs: null });
    const store = new AuditStoreSupabase(sb);
    expect(await store.obtenerFactura('X')).toBeUndefined();
  });

  it('registrarTransicion valida la máquina de estados ANTES de llamar la RPC', async () => {
    const fila: Fila = {
      factura_id: payload.factura_id, estado: 'BORRADOR',
      payload_json: '{}', payload_hash: 'h', folio_sii: null, pdf_path: null,
    };
    const { sb, rpc } = clienteFalso({ invoice_runs: fila });
    const store = new AuditStoreSupabase(sb);
    await expect(store.registrarTransicion(payload.factura_id, 'EMITIDA', 'salto')).rejects.toThrow(
      /Transición prohibida/,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it('registrarTransicion pasa el estado leído a la RPC (CAS) y mapea el conflicto', async () => {
    const fila: Fila = {
      factura_id: payload.factura_id, estado: 'PENDIENTE_APROBACION',
      payload_json: '{}', payload_hash: 'h', folio_sii: null, pdf_path: null,
    };
    const { sb, rpc } = clienteFalso({ invoice_runs: fila });
    const store = new AuditStoreSupabase(sb);
    await store.registrarTransicion(payload.factura_id, 'CANCELADA', 'motivo');
    expect(rpc).toHaveBeenCalledWith('registrar_transicion', {
      p_factura_id: payload.factura_id,
      p_desde: 'PENDIENTE_APROBACION',
      p_hacia: 'CANCELADA',
      p_detalle: 'motivo',
    });
    rpc.mockResolvedValue({ error: { message: 'TRANSICION_CONCURRENTE' } });
    await expect(
      store.registrarTransicion(payload.factura_id, 'CANCELADA', 'motivo'),
    ).rejects.toThrow(/concurrente/i);
  });

  it('registrarIntentoCorreo convierte el booleano a entero como en SQLite', async () => {
    const { sb, escrituras } = clienteFalso();
    const store = new AuditStoreSupabase(sb);
    await store.registrarIntentoCorreo('X', true, 'enviado');
    await store.registrarIntentoCorreo('X', false, 'falló');
    const inserciones = escrituras.filter((e) => e.tabla === 'email_attempts');
    expect(inserciones[0]?.args[0]).toMatchObject({ exito: 1 });
    expect(inserciones[1]?.args[0]).toMatchObject({ exito: 0 });
  });

  it('registrarAprobacion usa upsert (reemplaza la aprobación previa)', async () => {
    const { sb, escrituras } = clienteFalso();
    const store = new AuditStoreSupabase(sb);
    await store.registrarAprobacion('X', 'andres', 'h', '2026-07-25T00:00:00Z');
    const upserts = escrituras.filter((e) => e.tabla === 'approvals' && e.metodo === 'upsert');
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.args[0]).toMatchObject({ factura_id: 'X', actor: 'andres' });
  });
});
