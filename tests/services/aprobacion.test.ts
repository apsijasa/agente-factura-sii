// tests/services/aprobacion.test.ts
import { describe, expect, it } from 'vitest';
import { ApprovalService, resumenAprobacion } from '../../src/services/aprobacion.js';
import { hashPayload } from '../../src/domain/hash.js';
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
      cobro_id: 'C1', descripcion: 'Servicio', moneda: 'CLP',
      monto_neto_original: 100000, cantidad: 1, precio_unitario_clp: 100000, total_linea_clp: 100000,
    },
  ],
  neto_clp: 100000,
  iva_clp: 19000,
  total_clp: 119000,
  remitente: 'facturas@empresa.cl',
  destinatarios: ['pagos@cliente.cl'],
  copia: ['copia@empresa.cl'],
};

function servicio(respuesta: string | null) {
  const io = {
    pregunta: async () => {
      if (respuesta === null) throw new Error('expirada');
      return respuesta;
    },
  };
  return new ApprovalService(io, () => new Date('2026-07-05T10:00:00Z'), 'andres');
}

describe('resumenAprobacion', () => {
  it('muestra totales, destinatarios y RUT oculto, nunca el RUT completo', () => {
    const texto = resumenAprobacion(payload, '/raiz/cliente/NCA/2026/07/x.pdf');
    expect(texto).toContain('Emisora SpA');
    expect(texto).toContain('11******-1');
    expect(texto).not.toContain('11111111-1');
    expect(texto).toContain('119.000');
    expect(texto).toContain('pagos@cliente.cl');
  });
});

describe('ApprovalService', () => {
  it('aprueba solo con el texto exacto APROBAR <factura_id>', async () => {
    const r = await servicio(`APROBAR ${payload.factura_id}`).solicitarAprobacion(payload, '/ruta.pdf');
    expect(r.aprobada).toBe(true);
    expect(r.hash).toBe(hashPayload(payload));
    expect(r.actor).toBe('andres');
    expect(r.fecha).toBe('2026-07-05T10:00:00.000Z');
  });

  it('rechaza cualquier otra respuesta', async () => {
    for (const texto of ['aprobar', 'APROBAR otra-id', 'si', '']) {
      const r = await servicio(texto).solicitarAprobacion(payload, '/ruta.pdf');
      expect(r.aprobada).toBe(false);
    }
  });

  it('valida el hash vigente antes de emitir', () => {
    const s = servicio('x');
    const hash = hashPayload(payload);
    expect(s.hashVigente(payload, hash)).toBe(true);
    expect(s.hashVigente({ ...payload, total_clp: 1 }, hash)).toBe(false);
  });
});
