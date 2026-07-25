// tests/cli/comandos.test.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ejecutarCancel, ejecutarPrepare, ejecutarEmit, ejecutarPreviewSii, ejecutarRetryEmail } from '../../src/cli/comandos.js';
import { AuditStore } from '../../src/store/audit-store.js';
import { AlmacenPdfLocal } from '../../src/services/almacen-pdf.js';
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
    uf: {
      obtenerValorUf: vi.fn(async () => ({
        valor: 39418.53,
        fecha: '2026-07-05',
        url: 'https://www.sii.cl/valores_y_fechas/uf/uf2026.htm',
        consultadoEn: '2026-07-05T09:00:00.000Z',
      })),
    } as never,
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
    pdfs: new AlmacenPdfLocal(mkdtempSync(join(tmpdir(), 'clientes-'))),
    hoy: () => '2026-07-05',
  };
}

describe('ejecutarPrepare (simulación)', () => {
  it('crea la factura en PENDIENTE_APROBACION sin tocar SII ni correo', async () => {
    const deps = dependenciasSimuladas();
    const resultado = await ejecutarPrepare(deps, '2026-07-05');
    expect(resultado.preparadas).toEqual(['RECURRENT:E1:CL1:2026-07']);
    expect((await deps.store.obtenerFactura('RECURRENT:E1:CL1:2026-07'))?.estado).toBe('PENDIENTE_APROBACION');
    expect((deps.sii.abrirYPreparar as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((deps.correo.enviarFactura as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((deps.excel.agregarFilaFacturas as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('registra la procedencia del valor UF (valor, fecha, url y momento) en la auditoría', async () => {
    const deps = dependenciasSimuladas();
    await ejecutarPrepare(deps, '2026-07-05');
    const eventos = await deps.store.obtenerEventos('RECURRENT:E1:CL1:2026-07');
    const conProcedencia = eventos.find((e) => e.detalle.includes('https://www.sii.cl/valores_y_fechas/uf/uf2026.htm'));
    expect(conProcedencia).toBeDefined();
    expect(conProcedencia?.detalle).toContain('39418.53');
    expect(conProcedencia?.detalle).toContain('2026-07-05');
    expect(conProcedencia?.detalle).toContain('2026-07-05T09:00:00.000Z');
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
    const f = await deps.store.obtenerFactura('RECURRENT:E1:CL1:2026-07');
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
    expect((await deps.store.obtenerFactura('RECURRENT:E1:CL1:2026-07'))?.estado).toBe('REQUIERE_REVISION');
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

  it('no emite si el payload del store cambió después de la aprobación (TOCTOU)', async () => {
    const deps = dependenciasSimuladas();
    await ejecutarPrepare(deps, '2026-07-05');
    // Tras la aprobación, cualquier lectura fresca del store devuelve un hash
    // adulterado: la verificación post-aprobación debe abortar sin emitir.
    let adulterar = false;
    const original = deps.store.obtenerFactura.bind(deps.store);
    vi.spyOn(deps.store, 'obtenerFactura').mockImplementation(async (id: string) => {
      const fila = await original(id);
      if (adulterar && fila) return { ...fila, payload_hash: 'hash-adulterado' };
      return fila;
    });
    (deps.aprobacion.solicitarAprobacion as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      adulterar = true;
      return { aprobada: true, hash: '', actor: 'andres', fecha: '2026-07-05T10:00:00Z' };
    });
    await expect(ejecutarEmit(deps, 'RECURRENT:E1:CL1:2026-07')).rejects.toThrow(/aprobaci[oó]n|cambió/i);
    expect((deps.sii.emitirUnaVez as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('persiste el folio hallado en documentos emitidos ante emisión incierta', async () => {
    const deps = dependenciasSimuladas();
    (deps.sii.emitirUnaVez as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('conexión perdida'));
    (deps.sii.consultarDocumentosEmitidos as ReturnType<typeof vi.fn>).mockResolvedValue('55443');
    await ejecutarPrepare(deps, '2026-07-05');
    await expect(ejecutarEmit(deps, 'RECURRENT:E1:CL1:2026-07')).rejects.toThrow(/incierta/i);
    const f = await deps.store.obtenerFactura('RECURRENT:E1:CL1:2026-07');
    expect(f?.estado).toBe('REQUIERE_REVISION');
    expect(f?.folio_sii).toBe('55443');
    expect((deps.sii.emitirUnaVez as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
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
    const f = await deps.store.obtenerFactura('RECURRENT:E1:CL1:2026-07');
    expect(f?.estado).toBe('ERROR_REINTENTABLE');
    expect(f?.folio_sii).toBe('99887');
    expect((deps.sii.emitirUnaVez as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((deps.sii.consultarDocumentosEmitidos as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

describe('ejecutarPreviewSii', () => {
  it('se detiene antes de emitir cuando los totales coinciden', async () => {
    const deps = dependenciasSimuladas();
    await ejecutarPrepare(deps, '2026-07-05');
    await ejecutarPreviewSii(deps, 'RECURRENT:E1:CL1:2026-07');
    expect((deps.sii.abrirYPreparar as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((deps.sii.extraerPreview as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((deps.sii.emitirUnaVez as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((await deps.store.obtenerFactura('RECURRENT:E1:CL1:2026-07'))?.estado).toBe('PENDIENTE_APROBACION');
  });
});

describe('ejecutarCancel', () => {
  it('cancela una factura PENDIENTE_APROBACION con motivo, sin tocar SII ni correo', async () => {
    const deps = dependenciasSimuladas();
    await ejecutarPrepare(deps, '2026-07-05');
    await ejecutarCancel(deps, 'RECURRENT:E1:CL1:2026-07', 'emitida manualmente en el portal');
    const f = await deps.store.obtenerFactura('RECURRENT:E1:CL1:2026-07');
    expect(f?.estado).toBe('CANCELADA');
    const eventos = await deps.store.obtenerEventos('RECURRENT:E1:CL1:2026-07');
    expect(eventos.at(-1)?.hacia).toBe('CANCELADA');
    expect(eventos.at(-1)?.detalle).toContain('emitida manualmente en el portal');
    expect((deps.excel.actualizarFilaFacturas as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'RECURRENT:E1:CL1:2026-07',
      expect.objectContaining({ estado: 'CANCELADA' }),
    );
    expect((deps.sii.abrirYPreparar as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((deps.sii.emitirUnaVez as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((deps.correo.enviarFactura as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('exige un motivo no vacío', async () => {
    const deps = dependenciasSimuladas();
    await ejecutarPrepare(deps, '2026-07-05');
    await expect(ejecutarCancel(deps, 'RECURRENT:E1:CL1:2026-07', '   ')).rejects.toThrow(/motivo/i);
    expect((await deps.store.obtenerFactura('RECURRENT:E1:CL1:2026-07'))?.estado).toBe('PENDIENTE_APROBACION');
  });

  it('rechaza cancelar una factura ya emitida (estado terminal con folio)', async () => {
    const deps = dependenciasSimuladas();
    await ejecutarPrepare(deps, '2026-07-05');
    await ejecutarEmit(deps, 'RECURRENT:E1:CL1:2026-07');
    await expect(ejecutarCancel(deps, 'RECURRENT:E1:CL1:2026-07', 'motivo')).rejects.toThrow(/ENVIADA|no se puede cancelar/i);
    const f = await deps.store.obtenerFactura('RECURRENT:E1:CL1:2026-07');
    expect(f?.estado).toBe('ENVIADA');
    expect(f?.folio_sii).toBe('12345');
  });

  it('la cancelación en SQLite prevalece aunque falle el reflejo en Excel', async () => {
    const deps = dependenciasSimuladas();
    await ejecutarPrepare(deps, '2026-07-05');
    (deps.excel.actualizarFilaFacturas as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Graph caído'));
    await ejecutarCancel(deps, 'RECURRENT:E1:CL1:2026-07', 'emitida manualmente');
    expect((await deps.store.obtenerFactura('RECURRENT:E1:CL1:2026-07'))?.estado).toBe('CANCELADA');
  });
});

describe('ejecutarRetryEmail', () => {
  async function llevarADescargada(deps: Dependencias, facturaId: string): Promise<void> {
    const ruta = join(mkdtempSync(join(tmpdir(), 'pdf-')), 'f.pdf');
    writeFileSync(ruta, '%PDF-1.4\n%%EOF\n');
    await deps.store.registrarTransicion(facturaId, 'APROBADA', 'aprobada');
    await deps.store.registrarTransicion(facturaId, 'EMITIENDO', 'emisión');
    await deps.store.registrarTransicion(facturaId, 'EMITIDA', 'folio 12345');
    await deps.store.guardarFolio(facturaId, '12345');
    await deps.store.guardarRutaPdf(facturaId, ruta);
    await deps.store.registrarTransicion(facturaId, 'DESCARGADA', ruta);
  }

  it('reintenta solo el correo y nunca toca el SiiAdapter', async () => {
    const deps = dependenciasSimuladas();
    await ejecutarPrepare(deps, '2026-07-05');
    await llevarADescargada(deps, 'RECURRENT:E1:CL1:2026-07');
    await ejecutarRetryEmail(deps, 'RECURRENT:E1:CL1:2026-07');
    expect((await deps.store.obtenerFactura('RECURRENT:E1:CL1:2026-07'))?.estado).toBe('ENVIADA');
    expect((deps.correo.enviarFactura as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((deps.sii.abrirYPreparar as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((deps.sii.extraerPreview as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((deps.sii.emitirUnaVez as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((deps.sii.consultarDocumentosEmitidos as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('exige folio y PDF verificado antes de reintentar', async () => {
    const deps = dependenciasSimuladas();
    await ejecutarPrepare(deps, '2026-07-05');
    await expect(ejecutarRetryEmail(deps, 'RECURRENT:E1:CL1:2026-07')).rejects.toThrow(/folio|PDF/i);
    expect((deps.correo.enviarFactura as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
