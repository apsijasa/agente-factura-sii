// tests/store/facturas-repository.test.ts
import { describe, expect, it, vi } from 'vitest';
import { FacturasRepository, filaExcelDesdePayload } from '../../src/store/facturas-repository.js';
import { AuditStore } from '../../src/store/audit-store.js';
import type { ExcelAdapter } from '../../src/adapters/excel/excel-adapter.js';
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
  valor_uf: 39418.53,
  lineas: [
    { cobro_id: 'C1', descripcion: 'A', moneda: 'UF', monto_neto_original: 33.5, cantidad: 1, precio_unitario_clp: 1320521, total_linea_clp: 1320521 },
    { cobro_id: 'C2', descripcion: 'B', moneda: 'CLP', monto_neto_original: 100, cantidad: 1, precio_unitario_clp: 100, total_linea_clp: 100 },
  ],
  neto_clp: 1320621,
  iva_clp: 250918,
  total_clp: 1571539,
  remitente: 'f@e.cl',
  destinatarios: ['a@b.cl'],
  copia: ['c@e.cl'],
};

describe('filaExcelDesdePayload', () => {
  it('une los cobro_id con punto y coma y formatea montos', () => {
    const fila = filaExcelDesdePayload(payload, 'BORRADOR');
    expect(fila.cobro_id).toBe('C1;C2');
    expect(fila.valor_uf).toBe('39418.53');
    expect(fila.monto_neto_clp).toBe('1320621');
    expect(fila.estado).toBe('BORRADOR');
    expect(fila.folio_sii).toBe('');
  });
});

describe('FacturasRepository.reconciliar', () => {
  function crear(filasExcel: Record<string, string>[]) {
    const store = new AuditStore(':memory:');
    const excel = {
      leerTabla: vi.fn().mockResolvedValue(filasExcel),
      agregarFilaFacturas: vi.fn(),
      actualizarFilaFacturas: vi.fn(),
    } as unknown as ExcelAdapter;
    return { store, excel, repo: new FacturasRepository(store, excel) };
  }

  it('pasa cuando Excel y SQLite son consistentes', async () => {
    const { store, repo } = crear([
      { factura_id: payload.factura_id, folio_sii: '', estado: 'BORRADOR' },
    ]);
    store.crearFactura(payload, 'h');
    await expect(repo.reconciliar()).resolves.toBeUndefined();
  });

  it('detiene el proceso si Excel tiene folio y SQLite no registra emisión', async () => {
    const { store, repo } = crear([
      { factura_id: payload.factura_id, folio_sii: '999', estado: 'EMITIDA' },
    ]);
    store.crearFactura(payload, 'h'); // queda en BORRADOR, sin folio
    await expect(repo.reconciliar()).rejects.toThrow(/contradicci[oó]n/i);
  });

  it('detiene el proceso si SQLite tiene folio y la fila no está en Excel', async () => {
    const { store, repo } = crear([]);
    store.crearFactura(payload, 'h');
    store.registrarTransicion(payload.factura_id, 'PENDIENTE_APROBACION', 't');
    store.registrarTransicion(payload.factura_id, 'APROBADA', 't');
    store.registrarTransicion(payload.factura_id, 'EMITIENDO', 't');
    store.registrarTransicion(payload.factura_id, 'EMITIDA', 't');
    store.guardarFolio(payload.factura_id, '777');
    await expect(repo.reconciliar()).rejects.toThrow(/contradicci[oó]n/i);
  });

  it('detiene el proceso si los folios de Excel y SQLite difieren', async () => {
    const { store, repo } = crear([
      { factura_id: payload.factura_id, folio_sii: '999', estado: 'EMITIDA' },
    ]);
    store.crearFactura(payload, 'h');
    store.registrarTransicion(payload.factura_id, 'PENDIENTE_APROBACION', 't');
    store.registrarTransicion(payload.factura_id, 'APROBADA', 't');
    store.registrarTransicion(payload.factura_id, 'EMITIENDO', 't');
    store.registrarTransicion(payload.factura_id, 'EMITIDA', 't');
    store.guardarFolio(payload.factura_id, '777');
    await expect(repo.reconciliar()).rejects.toThrow(/contradicci[oó]n/i);
  });

  it('trata un folio de solo espacios en Excel como ausente', async () => {
    const { store, repo } = crear([
      { factura_id: payload.factura_id, folio_sii: '   ', estado: 'BORRADOR' },
    ]);
    store.crearFactura(payload, 'h'); // sin folio en SQLite
    await expect(repo.reconciliar()).resolves.toBeUndefined();
  });
});
