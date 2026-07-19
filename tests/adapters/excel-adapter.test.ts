// tests/adapters/excel-adapter.test.ts
import { describe, expect, it, vi } from 'vitest';
import { ENCABEZADOS, ExcelAdapter } from '../../src/adapters/excel/excel-adapter.js';
import type { IGraphClient } from '../../src/adapters/graph/graph-client.js';

function graphFalso(respuestas: Record<string, unknown>): IGraphClient & { solicitar: ReturnType<typeof vi.fn> } {
  const solicitar = vi.fn(async (_metodo: string, ruta: string) => {
    for (const [clave, valor] of Object.entries(respuestas)) {
      if (ruta.includes(clave)) return valor;
    }
    throw new Error(`Ruta no esperada en el test: ${ruta}`);
  });
  return { solicitar } as unknown as IGraphClient & { solicitar: ReturnType<typeof vi.fn> };
}

const cfg = { driveId: 'D1', itemId: 'I1' };

function valoresFactura(facturaId: string, montoNeto = '100'): string[] {
  return [facturaId, 'C1', '2026-07', '2026-07-05', '', montoNeto, '19', '119', '', 'BORRADOR', '', '', '', '', ''];
}

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

  it('sigue @odata.nextLink hasta agotar las páginas quitando la base de Graph', async () => {
    const graph = graphFalso({
      'tables/tblEmpresas/headerRowRange': { values: [ENCABEZADOS.tblEmpresas] },
      'skip=1': {
        value: [{ values: [['E2', '11.111.111-1', 'Segunda SpA', 'f2@e.cl', 'c2@e.cl', 'TRUE']] }],
      },
      'tables/tblEmpresas/rows': {
        value: [{ values: [['E1', '12.345.678-5', 'Emisora SpA', 'f@e.cl', 'c@e.cl', 'TRUE']] }],
        '@odata.nextLink':
          'https://graph.microsoft.com/v1.0/drives/D1/items/I1/workbook/tables/tblEmpresas/rows?$skip=1',
      },
    });
    const adaptador = new ExcelAdapter(graph, cfg);
    const filas = await adaptador.leerTabla('tblEmpresas');
    expect(filas).toHaveLength(2);
    expect(filas[0]?.empresa_id).toBe('E1');
    expect(filas[1]?.empresa_id).toBe('E2');
    const segunda = graph.solicitar.mock.calls.find((c) => String(c[1]).includes('skip=1'));
    expect(String(segunda?.[1]).startsWith('https://')).toBe(false);
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
      'rows/itemAt(index=0)': { index: 0, values: [valoresFactura('RECURRENT:E1:CL1:2026-07')] },
      'tables/tblFacturas/rows': {
        value: [{ index: 0, values: [valoresFactura('RECURRENT:E1:CL1:2026-07')] }],
      },
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

  it('usa el índice de Graph de la fila, no su posición en el arreglo', async () => {
    const objetivo = 'RECURRENT:E1:CL2:2026-07';
    const graph = graphFalso({
      'tables/tblFacturas/headerRowRange': { values: [ENCABEZADOS.tblFacturas] },
      // La relectura devuelve un monto distinto al de la lista: el PATCH debe partir de la relectura.
      'rows/itemAt(index=7)': { index: 7, values: [valoresFactura(objetivo, '200')] },
      'tables/tblFacturas/rows': {
        value: [
          { index: 5, values: [valoresFactura('RECURRENT:E1:CL1:2026-07')] },
          { index: 7, values: [valoresFactura(objetivo, '100')] },
          { index: 9, values: [valoresFactura('RECURRENT:E1:CL3:2026-07')] },
        ],
      },
    });
    const adaptador = new ExcelAdapter(graph, cfg);
    await adaptador.actualizarFilaFacturas(objetivo, { estado: 'EMITIDA' });
    const patch = graph.solicitar.mock.calls.find((c) => c[0] === 'PATCH');
    expect(String(patch?.[1])).toContain('rows/itemAt(index=7)');
    const valores = (patch?.[2] as { values: string[][] }).values[0]!;
    expect(valores[0]).toBe(objetivo);
    expect(valores[5]).toBe('200'); // proviene de la relectura, no de la lista
    expect(valores[9]).toBe('EMITIDA');
  });

  it('lanza sin emitir PATCH si la fila cambió entre la lectura y la escritura', async () => {
    const objetivo = 'RECURRENT:E1:CL2:2026-07';
    const graph = graphFalso({
      'tables/tblFacturas/headerRowRange': { values: [ENCABEZADOS.tblFacturas] },
      'rows/itemAt(index=7)': { index: 7, values: [valoresFactura('RECURRENT:E9:CL9:2026-07')] },
      'tables/tblFacturas/rows': {
        value: [{ index: 7, values: [valoresFactura(objetivo)] }],
      },
    });
    const adaptador = new ExcelAdapter(graph, cfg);
    await expect(adaptador.actualizarFilaFacturas(objetivo, { estado: 'EMITIDA' })).rejects.toThrow(
      /cambió|concurrente/i,
    );
    const patches = graph.solicitar.mock.calls.filter((c) => c[0] === 'PATCH');
    expect(patches).toHaveLength(0);
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
