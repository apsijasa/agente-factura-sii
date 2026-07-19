// tests/domain/hash.test.ts
import { describe, expect, it } from 'vitest';
import { hashPayload, jsonCanonico } from '../../src/domain/hash.js';
import type { InvoicePayload } from '../../src/domain/tipos.js';

const payload: InvoicePayload = {
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
  valor_uf: 39418.53,
  lineas: [
    {
      cobro_id: 'C1',
      descripcion: 'Asesoría',
      moneda: 'UF',
      monto_neto_original: 33.5,
      cantidad: 1,
      precio_unitario_clp: 1320521,
      total_linea_clp: 1320521,
    },
  ],
  neto_clp: 1320521,
  iva_clp: 250899,
  total_clp: 1571420,
  remitente: 'facturas@empresa.cl',
  destinatarios: ['pagos@cliente.cl'],
  copia: ['copia@empresa.cl'],
};

describe('jsonCanonico', () => {
  it('ordena claves alfabéticamente en todos los niveles', () => {
    expect(jsonCanonico({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it('preserva el orden de los arreglos', () => {
    expect(jsonCanonico([2, 1])).toBe('[2,1]');
  });
});

describe('hashPayload', () => {
  it('es determinista e independiente del orden de claves', () => {
    const clon = JSON.parse(jsonCanonico(payload)) as InvoicePayload;
    expect(hashPayload(payload)).toBe(hashPayload(clon));
    expect(hashPayload(payload)).toMatch(/^[a-f0-9]{64}$/);
  });
  it('cambia si cambia cualquier campo del payload', () => {
    expect(hashPayload({ ...payload, total_clp: 1571421 })).not.toBe(hashPayload(payload));
    expect(hashPayload({ ...payload, destinatarios: ['otro@x.cl'] })).not.toBe(hashPayload(payload));
  });
});
