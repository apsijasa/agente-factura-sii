// tests/cli/comandos.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ejecutarPrepare, ejecutarEmit } from '../../src/cli/comandos.js';
import { AuditStore } from '../../src/store/audit-store.js';
import { EmisionConfirmadaSinPdfError } from '../../src/adapters/sii/sii-adapter.js';
import type { Dependencias } from '../../src/cli/comandos.js';

const filasEmpresas = [
  { empresa_id: 'E1', rut_emisor: '12.345.678-5', razon_social: 'Emisora SpA', email_remitente: 'f@e.cl', email_copia: 'c@e.cl', activo: 'TRUE' },
];
const filasClientes = [
  { cliente_id: 'CL1', razon_social: 'Cliente Ltda', nombre_carpeta: 'NCA', rut_cliente: '11.111.111-1', email_facturacion: 'pagos@cliente.cl', giro: 'Servicios', direccion: 'Calle 1', comuna: 'Prov', ciudad: 'Stgo', activo: 'TRUE' },
];
const filasCobros = [
  { cobro_id: 'C1', empresa_id: 'E1', cliente_id: 'CL1', descripcion_servicio: 'Asesoría', moneda: 'UF', monto_neto: '33.5', cantidad: '1', frecuencia: 'MENSUAL', dia_emision: '5', forma_pago: 'CONTADO', dias_vencimiento: '0', fecha_inicio: '2026-01-01', fecha_fin: '', activo: 'TRUE' },
];

// Deviación autorizada: carpeta temporal aislada por test en vez de una ruta
// fija en /tmp (evita colisiones entre tests y no ensucia la raíz de /tmp).
function dependenciasSimuladas(): Dependencias {
  const store = new AuditStore(':memory:');
  const tablas: Record<string, Record<string, string>[]> = {
    tblEmpresas: filasEmpresas,
    tblClientes: filasClientes,
    tblCobrosRecurrentes: filasCobros,
    tblFacturas: [],
  };
  return {
    store,
    excel: {
      leerTabla: vi.fn(async (nombre: string) => tablas[nombre] ?? []),
      agregarFilaFacturas: vi.fn(async (fila) => { tablas.tblFacturas!.push(fila as never); }),
      actualizarFilaFacturas: vi.fn(async () => undefined),
    } as never,
    uf: { obtenerValorUf: vi.fn(async () => ({ valor: 39418.53, fecha: '2026-07-05', url: 'x', consultadoEn: 'y' })) } as never,
    sii: {
      abrirYPreparar: vi.fn(),
      extraerPreview: vi.fn(async () => ({ totales: { netoClp: 1320521, ivaClp: 250899, totalClp: 1571420 }, coinciden: true, diferencias: [] })),
      emitirUnaVez: vi.fn(async () => ({ folio: '12345', pdf: Buffer.from('%PDF-1.4\n%%EOF\n') })),
      consultarDocumentosEmitidos: vi.fn(async () => null),
      cerrar: vi.fn(),
    } as never,
    correo: { enviarFactura: vi.fn(async () => undefined) } as never,
    aprobacion: {
      solicitarAprobacion: vi.fn(async () => ({ aprobada: true, hash: '', actor: 'andres', fecha: '2026-07-05T10:00:00Z' })),
      hashVigente: vi.fn(() => true),
    } as never,
    clasificaciones: { E1: { tipoVenta: 'Del Giro', tipoCompra: 'Del Giro' } },
    rutaRaizClientes: mkdtempSync(join(tmpdir(), 'clientes-')),
    hoy: () => '2026-07-05',
  };
}

describe('ejecutarPrepare (simulación)', () => {
  it('crea la factura en PENDIENTE_APROBACION sin tocar SII ni correo', async () => {
    const deps = dependenciasSimuladas();
    const resultado = await ejecutarPrepare(deps, '2026-07-05');
    expect(resultado.preparadas).toEqual(['RECURRENT:E1:CL1:2026-07']);
    expect(deps.store.obtenerFactura('RECURRENT:E1:CL1:2026-07')?.estado).toBe('PENDIENTE_APROBACION');
    expect((deps.sii.abrirYPreparar as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((deps.correo.enviarFactura as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((deps.excel.agregarFilaFacturas as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('es idempotente: una segunda ejecución no duplica la factura', async () => {
    const deps = dependenciasSimuladas();
    await ejecutarPrepare(deps, '2026-07-05');
    const segunda = await ejecutarPrepare(deps, '2026-07-05');
    expect(segunda.preparadas).toEqual([]);
    expect(segunda.omitidas).toEqual(['RECURRENT:E1:CL1:2026-07']);
  });
});

describe('ejecutarEmit', () => {
  it('recorre el ciclo completo hasta ENVIADA con una sola emisión', async () => {
    const deps = dependenciasSimuladas();
    await ejecutarPrepare(deps, '2026-07-05');
    await ejecutarEmit(deps, 'RECURRENT:E1:CL1:2026-07');
    const f = deps.store.obtenerFactura('RECURRENT:E1:CL1:2026-07');
    expect(f?.estado).toBe('ENVIADA');
    expect(f?.folio_sii).toBe('12345');
    expect((deps.sii.emitirUnaVez as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('no emite si la vista previa del SII no coincide', async () => {
    const deps = dependenciasSimuladas();
    (deps.sii.extraerPreview as ReturnType<typeof vi.fn>).mockResolvedValue({
      totales: { netoClp: 1, ivaClp: 1, totalClp: 2 }, coinciden: false, diferencias: ['neto: esperado 1320521, SII muestra 1'],
    });
    await ejecutarPrepare(deps, '2026-07-05');
    await expect(ejecutarEmit(deps, 'RECURRENT:E1:CL1:2026-07')).rejects.toThrow(/coinciden|REVISION/i);
    expect(deps.store.obtenerFactura('RECURRENT:E1:CL1:2026-07')?.estado).toBe('REQUIERE_REVISION');
    expect((deps.sii.emitirUnaVez as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('no emite si el operador no aprueba', async () => {
    const deps = dependenciasSimuladas();
    (deps.aprobacion.solicitarAprobacion as ReturnType<typeof vi.fn>).mockResolvedValue({
      aprobada: false, hash: '', actor: 'andres', fecha: 'x',
    });
    await ejecutarPrepare(deps, '2026-07-05');
    await expect(ejecutarEmit(deps, 'RECURRENT:E1:CL1:2026-07')).rejects.toThrow(/aprobaci[oó]n/i);
    expect((deps.sii.emitirUnaVez as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  // Deviación autorizada: EmisionConfirmadaSinPdfError (folio confirmado, PDF
  // falló) debe preservar el folio y dejar la factura en ERROR_REINTENTABLE,
  // NUNCA en REQUIERE_REVISION (eso reabriría la puerta a una re-emisión).
  it('preserva el folio y queda ERROR_REINTENTABLE si la emisión fue confirmada pero falló el PDF', async () => {
    const deps = dependenciasSimuladas();
    (deps.sii.emitirUnaVez as ReturnType<typeof vi.fn>).mockRejectedValue(
      new EmisionConfirmadaSinPdfError('99887', 'timeout'),
    );
    await ejecutarPrepare(deps, '2026-07-05');
    await expect(ejecutarEmit(deps, 'RECURRENT:E1:CL1:2026-07')).rejects.toThrow(/99887|PDF/i);
    const f = deps.store.obtenerFactura('RECURRENT:E1:CL1:2026-07');
    expect(f?.estado).toBe('ERROR_REINTENTABLE');
    expect(f?.folio_sii).toBe('99887');
    expect((deps.sii.emitirUnaVez as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((deps.sii.consultarDocumentosEmitidos as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
