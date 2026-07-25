// tests/cli/comandos-nube.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ejecutarEmitAprobadas, ejecutarNotify, ejecutarPrepare } from '../../src/cli/comandos.js';
import { AuditStore } from '../../src/store/audit-store.js';
import { AlmacenPdfLocal } from '../../src/services/almacen-pdf.js';
import { AprobacionRemota } from '../../src/services/aprobacion.js';
import { verificarToken } from '../../src/services/token-aprobacion.js';
import type { Dependencias } from '../../src/cli/comandos.js';
import type { CanalNotificacion } from '../../src/services/notificador.js';

const filasEmpresas = [
  { empresa_id: 'E1', rut_emisor: '12.345.678-5', razon_social: 'Emisora SpA', email_remitente: 'f@e.cl', email_copia: 'c@e.cl', activo: 'TRUE' },
];
const filasClientes = [
  { cliente_id: 'CL1', razon_social: 'Cliente Ltda', nombre_carpeta: 'NCA', rut_cliente: '11.111.111-1', email_facturacion: 'pagos@cliente.cl', giro: 'Servicios', direccion: 'Calle 1', comuna: 'Prov', ciudad: 'Stgo', activo: 'TRUE' },
];
const filasCobros = [
  { cobro_id: 'C1', empresa_id: 'E1', cliente_id: 'CL1', descripcion_servicio: 'Asesoría', moneda: 'CLP', monto_neto: '100000', cantidad: '1', frecuencia: 'MENSUAL', dia_emision: '5', forma_pago: 'CONTADO', dias_vencimiento: '0', fecha_inicio: '2026-01-01', fecha_fin: '', activo: 'TRUE' },
];

const FACTURA = 'RECURRENT:E1:CL1:2026-07';
const SECRETO = 'secreto-de-prueba';

function depsNube(): Dependencias {
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
      agregarFilaFacturas: vi.fn(async () => undefined),
      actualizarFilaFacturas: vi.fn(async () => undefined),
    } as never,
    uf: { obtenerValorUf: vi.fn() } as never,
    sii: {
      abrirYPreparar: vi.fn(),
      extraerPreview: vi.fn(async () => ({ totales: { netoClp: 100000, ivaClp: 19000, totalClp: 119000 }, coinciden: true, diferencias: [] })),
      emitirUnaVez: vi.fn(async () => ({ folio: '77', pdf: Buffer.from('%PDF-1.4\n%%EOF\n') })),
      consultarDocumentosEmitidos: vi.fn(async () => null),
      cerrar: vi.fn(),
    } as never,
    correo: { enviarFactura: vi.fn(async () => undefined) } as never,
    aprobacion: new AprobacionRemota(store),
    clasificaciones: { E1: { tipoVenta: 'Del Giro', tipoCompra: 'Del Giro' } },
    pdfs: new AlmacenPdfLocal(mkdtempSync(join(tmpdir(), 'clientes-'))),
    hoy: () => '2026-07-05',
  };
}

const opcionesNotify = {
  urlAprobacion: 'https://x.supabase.co/functions/v1/aprobar',
  secreto: SECRETO,
  vigenciaHoras: 48,
  ahora: () => new Date('2026-07-05T12:00:00Z'),
};

describe('ejecutarNotify', () => {
  it('notifica solo las PENDIENTE_APROBACION sin aprobación, con token verificable', async () => {
    const deps = depsNube();
    await ejecutarPrepare(deps, '2026-07-05');
    const mensajes: string[] = [];
    const canal: CanalNotificacion = { enviar: async (m) => void mensajes.push(m) };

    const notificadas = await ejecutarNotify(deps, canal, opcionesNotify);

    expect(notificadas).toEqual([FACTURA]);
    expect(mensajes).toHaveLength(1);
    const token = /token=([^\s]+)/.exec(mensajes[0]!)?.[1];
    expect(token).toBeDefined();
    const datos = verificarToken(token!, SECRETO, new Date('2026-07-05T13:00:00Z'));
    expect(datos.facturaId).toBe(FACTURA);
    const fila = await deps.store.obtenerFactura(FACTURA);
    expect(datos.payloadHash).toBe(fila?.payload_hash);
  });

  it('no re-notifica una factura que ya tiene aprobación vigente', async () => {
    const deps = depsNube();
    await ejecutarPrepare(deps, '2026-07-05');
    const fila = await deps.store.obtenerFactura(FACTURA);
    await deps.store.registrarAprobacion(FACTURA, 'aprobacion-remota', fila!.payload_hash, '2026-07-05T12:30:00Z');
    const canal: CanalNotificacion = { enviar: vi.fn(async () => undefined) };
    const notificadas = await ejecutarNotify(deps, canal, opcionesNotify);
    expect(notificadas).toEqual([]);
    expect(canal.enviar).not.toHaveBeenCalled();
  });

  it('sí re-notifica si la aprobación quedó obsoleta (hash distinto)', async () => {
    const deps = depsNube();
    await ejecutarPrepare(deps, '2026-07-05');
    await deps.store.registrarAprobacion(FACTURA, 'aprobacion-remota', 'hash-viejo', '2026-07-05T12:30:00Z');
    const canal: CanalNotificacion = { enviar: vi.fn(async () => undefined) };
    const notificadas = await ejecutarNotify(deps, canal, opcionesNotify);
    expect(notificadas).toEqual([FACTURA]);
  });
});

describe('ejecutarEmitAprobadas', () => {
  it('emite la factura con aprobación vigente y completa el ciclo hasta ENVIADA', async () => {
    const deps = depsNube();
    await ejecutarPrepare(deps, '2026-07-05');
    const fila = await deps.store.obtenerFactura(FACTURA);
    await deps.store.registrarAprobacion(FACTURA, 'aprobacion-remota', fila!.payload_hash, '2026-07-05T12:30:00Z');

    const resultado = await ejecutarEmitAprobadas(deps);

    expect(resultado.emitidas).toEqual([FACTURA]);
    const final = await deps.store.obtenerFactura(FACTURA);
    expect(final?.estado).toBe('ENVIADA');
    expect(final?.folio_sii).toBe('77');
  });

  it('no emite sin aprobación registrada', async () => {
    const deps = depsNube();
    await ejecutarPrepare(deps, '2026-07-05');
    const resultado = await ejecutarEmitAprobadas(deps);
    expect(resultado.emitidas).toEqual([]);
    expect((deps.sii.emitirUnaVez as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((await deps.store.obtenerFactura(FACTURA))?.estado).toBe('PENDIENTE_APROBACION');
  });

  it('no emite si la aprobación quedó ligada a otro contenido (hash distinto)', async () => {
    const deps = depsNube();
    await ejecutarPrepare(deps, '2026-07-05');
    await deps.store.registrarAprobacion(FACTURA, 'aprobacion-remota', 'hash-viejo', '2026-07-05T12:30:00Z');
    const resultado = await ejecutarEmitAprobadas(deps);
    expect(resultado.emitidas).toEqual([]);
    expect((deps.sii.emitirUnaVez as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('un fallo del SII deja la factura fuera de circulación y no detiene el ciclo', async () => {
    const deps = depsNube();
    await ejecutarPrepare(deps, '2026-07-05');
    const fila = await deps.store.obtenerFactura(FACTURA);
    await deps.store.registrarAprobacion(FACTURA, 'aprobacion-remota', fila!.payload_hash, '2026-07-05T12:30:00Z');
    (deps.sii.emitirUnaVez as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('portal caído'));

    const resultado = await ejecutarEmitAprobadas(deps);

    expect(resultado.emitidas).toEqual([]);
    expect(resultado.fallidas).toEqual([FACTURA]);
    expect((await deps.store.obtenerFactura(FACTURA))?.estado).toBe('REQUIERE_REVISION');
  });
});
