// tests/adapters/excel-adapter.test.ts
import { describe, expect, it, vi } from 'vitest';
import { ENCABEZADOS, ExcelAdapter } from '../../src/adapters/excel/excel-adapter.js';
import type { IGraphClient } from '../../src/adapters/graph/graph-client.js';

function graphFalso(respuestas: Record<string, unknown>): IGraphClient & { solicitar: ReturnType<typeof vi.fn> } {
  const solicitar = vi.fn(async (_metodo: string, ruta: string, _cuerpo?: unknown) => {
    for (const [clave, valor] of Object.entries(respuestas)) {
      if (ruta.includes(clave)) return valor;
    }
    throw new Error(`Ruta no esperada en el test: ${ruta}`);
  });
  return { solicitar } as unknown as IGraphClient & { solicitar: ReturnType<typeof vi.fn> };
}

const cfg = { driveId: 'D1', itemId: 'I1' };

describe('ExcelAdapter.leerTabla', () => {
  it('convierte filas de Graph en objetos usando los encabezados', async () => {
    const graph = graphFalso({
      "tables/tblEmpresas/headerRowRange": { values: [ENCABEZADOS.tblEmpresas] },
      "tables/tblEmpresas/rows": {
        value: [{ values: [['E1', '12.345.678-5', 'Emisora SpA', 'f@e.cl', 'c@e.cl', 'TRUE']] }],
      },
    });
    const adaptador = new ExcelAdapter(graph, cfg);
    const filas = await adaptador.leerTabla('tblEmpresas');
    expect(filas).toEqual([
      {
        empresa_id: 'E1',
        rut_emisor: '12.345.678-5',
        razon_social: 'Emisora SpA',
        email_remitente: 'f@e.cl',
        email_copia: 'c@e.cl',
        activo: 'TRUE',
      },
    ]);
  });

  it('rechaza encabezados que no coinciden exactamente', async () => {
    const graph = graphFalso({
      'tables/tblEmpresas/headerRowRange': { values: [['empresa_id', 'rut', 'x', 'y', 'z', 'w']] },
    });
    const adaptador = new ExcelAdapter(graph, cfg);
    await expect(adaptador.leerTabla('tblEmpresas')).rejects.toThrow(/Encabezados/);
  });

  it('rechaza nombres de tabla no conocidos', async () => {
    const adaptador = new ExcelAdapter(graphFalso({}), cfg);
    await expect(adaptador.leerTabla('tblOtra')).rejects.toThrow(/tabla/i);
  });
});

describe('ExcelAdapter.agregarFilaFacturas', () => {
  it('envía la fila en el orden exacto de encabezados de tblFacturas', async () => {
    const graph = graphFalso({ 'tables/tblFacturas/rows/add': {} });
    const adaptador = new ExcelAdapter(graph, cfg);
    await adaptador.agregarFilaFacturas({
      factura_id: 'RECURRENT:E1:CL1:2026-07',
      cobro_id: 'C1;C2',
      periodo: '2026-07',
      fecha_emision: '2026-07-05',
      valor_uf: '39418.53',
      monto_neto_clp: '1320521',
      iva_clp: '250899',
      total_clp: '1571420',
      folio_sii: '',
      estado: 'BORRADOR',
      pdf_path: '',
      aprobada_por: '',
      fecha_aprobacion: '',
      fecha_envio: '',
      error: '',
    });
    const llamada = graph.solicitar.mock.calls.find((c) => String(c[1]).includes('rows/add'));
    expect(llamada?.[0]).toBe('POST');
    expect((llamada?.[2] as { values: string[][] }).values[0]).toEqual([
      'RECURRENT:E1:CL1:2026-07', 'C1;C2', '2026-07', '2026-07-05', '39418.53',
      '1320521', '250899', '1571420', '', 'BORRADOR', '', '', '', '', '',
    ]);
  });
});

describe('ExcelAdapter.actualizarFilaFacturas', () => {
  it('localiza la fila por factura_id y aplica solo los cambios', async () => {
    const graph = graphFalso({
      'tables/tblFacturas/headerRowRange': { values: [ENCABEZADOS.tblFacturas] },
      'tables/tblFacturas/rows': {
        value: [
          { index: 0, values: [['RECURRENT:E1:CL1:2026-07', 'C1', '2026-07', '2026-07-05', '', '100', '19', '119', '', 'BORRADOR', '', '', '', '', '']] },
        ],
      },
      'range/insert': {},
      "rows/itemAt(index=0)": {},
    });
    const adaptador = new ExcelAdapter(graph, cfg);
    await adaptador.actualizarFilaFacturas('RECURRENT:E1:CL1:2026-07', {
      estado: 'EMITIDA',
      folio_sii: '12345',
    });
    const patch = graph.solicitar.mock.calls.find((c) => c[0] === 'PATCH');
    const valores = (patch?.[2] as { values: string[][] }).values[0]!;
    expect(valores[9]).toBe('EMITIDA');
    expect(valores[8]).toBe('12345');
  });

  it('lanza si la factura no existe en tblFacturas', async () => {
    const graph = graphFalso({
      'tables/tblFacturas/headerRowRange': { values: [ENCABEZADOS.tblFacturas] },
      'tables/tblFacturas/rows': { value: [] },
    });
    const adaptador = new ExcelAdapter(graph, cfg);
    await expect(adaptador.actualizarFilaFacturas('NO-EXISTE', { estado: 'EMITIDA' })).rejects.toThrow(
      /no encontrada/i,
    );
  });
});
