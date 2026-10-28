// tests/cli/procesar-solicitudes.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ejecutarProcesarSolicitudes } from '../../src/cli/comandos.js';
import { AuditStore } from '../../src/store/audit-store.js';
import { AlmacenPdfLocal } from '../../src/services/almacen-pdf.js';
import { AprobacionRemota } from '../../src/services/aprobacion.js';
import type { Dependencias } from '../../src/cli/comandos.js';
import type { RepoSolicitudes, SolicitudFactura } from '../../src/store/solicitudes-supabase.js';
import type { CanalNotificacion } from '../../src/services/notificador.js';

const filasEmpresas = [
  { empresa_id: 'E1', rut_emisor: '12.345.678-5', razon_social: 'Emisora SpA', email_remitente: 'f@e.cl', email_copia: 'c@e.cl', activo: 'TRUE' },
];
const filasClientes = [
  { cliente_id: 'CLI-022', razon_social: 'SOCIEDAD PM SPA', nombre_carpeta: 'SOCIEDAD PM', rut_cliente: '78.264.318-5', email_facturacion: 'pm@cliente.cl', giro: 'Servicios', direccion: 'Calle 1', comuna: 'Las Condes', ciudad: 'Santiago', activo: 'TRUE' },
];

function repoFalso(solicitudes: SolicitudFactura[]) {
  const procesadas: { id: number; facturaId: string }[] = [];
  const rechazadas: { id: number; error: string }[] = [];
  const repo: RepoSolicitudes = {
    pendientes: async () => solicitudes,
    marcarProcesada: async (id, facturaId) => void procesadas.push({ id, facturaId }),
    marcarRechazada: async (id, error) => void rechazadas.push({ id, error }),
  };
  return { repo, procesadas, rechazadas };
}

function depsSolicitudes(): Dependencias {
  const store = new AuditStore(':memory:');
  return {
    store,
    excel: {
      leerTabla: vi.fn(async (nombre: string) =>
        nombre === 'tblEmpresas' ? filasEmpresas : nombre === 'tblClientes' ? filasClientes : []),
      agregarFilaFacturas: vi.fn(async () => undefined),
      agregarFilaClientes: vi.fn(async () => undefined),
      actualizarFilaFacturas: vi.fn(async () => undefined),
    } as never,
    uf: {
      obtenerValorUf: vi.fn(async () => ({
        valor: 39500, fecha: '2026-07-26', url: 'https://www.sii.cl/uf', consultadoEn: '2026-07-26T10:00:00Z',
      })),
    } as never,
    sii: { abrirYPreparar: vi.fn(), extraerPreview: vi.fn(), emitirUnaVez: vi.fn(), consultarDocumentosEmitidos: vi.fn(), cerrar: vi.fn() } as never,
    correo: { enviarFactura: vi.fn(async () => undefined) } as never,
    aprobacion: new AprobacionRemota(store),
    clasificaciones: { E1: { tipoVenta: 'Del Giro', tipoCompra: 'Del Giro' } },
    pdfs: new AlmacenPdfLocal(mkdtempSync(join(tmpdir(), 'clientes-'))),
    hoy: () => '2026-07-26',
  };
}

function canalColector() {
  const mensajes: string[] = [];
  const canal: CanalNotificacion = { enviar: async (m) => void mensajes.push(m) };
  return { canal, mensajes };
}

describe('ejecutarProcesarSolicitudes', () => {
  it('procesa una solicitud CLP: factura PUNTUAL en PENDIENTE_APROBACION con IVA correcto', async () => {
    const deps = depsSolicitudes();
    const { repo, procesadas } = repoFalso([
      { id: 7, chat_id: '1', texto: '/factura CLI-022 250000 Asesoría contable julio' },
    ]);
    const { canal, mensajes } = canalColector();

    const r = await ejecutarProcesarSolicitudes(deps, repo, canal);

    const clave = 'PUNTUAL:E1:CLI-022:2026-07-26:7';
    expect(r.procesadas).toEqual([clave]);
    expect(procesadas).toEqual([{ id: 7, facturaId: clave }]);
    const f = await deps.store.obtenerFactura(clave);
    expect(f?.estado).toBe('PENDIENTE_APROBACION');
    const payload = JSON.parse(f!.payload_json) as { neto_clp: number; iva_clp: number; total_clp: number; rut_cliente: string; fecha_emision: string };
    expect(payload.neto_clp).toBe(250000);
    expect(payload.iva_clp).toBe(47500);
    expect(payload.total_clp).toBe(297500);
    expect(payload.rut_cliente).toBe('78264318-5');
    expect(payload.fecha_emision).toBe('2026-07-26');
    expect((deps.excel.agregarFilaFacturas as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(mensajes).toEqual([]);
  });

  it('una solicitud inválida se rechaza con aviso y NO detiene a las demás', async () => {
    const deps = depsSolicitudes();
    const { repo, procesadas, rechazadas } = repoFalso([
      { id: 1, chat_id: '1', texto: '/factura CLI-777 100000 Cliente fantasma' },
      { id: 2, chat_id: '1', texto: '/factura CLI-022 100000 Servicio real' },
    ]);
    const { canal, mensajes } = canalColector();

    const r = await ejecutarProcesarSolicitudes(deps, repo, canal);

    expect(r.rechazadas).toEqual([1]);
    expect(r.procesadas).toEqual(['PUNTUAL:E1:CLI-022:2026-07-26:2']);
    expect(rechazadas[0]?.error).toMatch(/no encontrado/i);
    expect(mensajes).toHaveLength(1);
    expect(mensajes[0]).toMatch(/rechazada/i);
    expect(procesadas).toHaveLength(1);
  });

  it('una solicitud UF usa el valor UF del día y lo registra en el payload', async () => {
    const deps = depsSolicitudes();
    const { repo } = repoFalso([
      { id: 3, chat_id: '1', texto: '/factura CLI-022 10UF Consultoría especial' },
    ]);
    const { canal } = canalColector();

    const r = await ejecutarProcesarSolicitudes(deps, repo, canal);

    expect(r.procesadas).toHaveLength(1);
    const f = await deps.store.obtenerFactura(r.procesadas[0] as string);
    const payload = JSON.parse(f!.payload_json) as { valor_uf: number | null; neto_clp: number };
    expect(payload.valor_uf).toBe(39500);
    expect(payload.neto_clp).toBe(395000);
    expect((deps.uf.obtenerValorUf as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('2026-07-26');
  });

  it('sin solicitudes pendientes no toca el Excel ni el store', async () => {
    const deps = depsSolicitudes();
    const { repo } = repoFalso([]);
    const { canal } = canalColector();
    const r = await ejecutarProcesarSolicitudes(deps, repo, canal);
    expect(r).toEqual({ procesadas: [], rechazadas: [], clientesCreados: [] });
    expect((deps.excel.leerTabla as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

// Alta de clientes puntuales por Telegram. El alta va separada de la factura a
// propósito: así el operador ve la razón social antes de que exista documento.
describe('ejecutarProcesarSolicitudes y /cliente-nuevo', () => {
  it('da de alta el cliente con el correlativo siguiente y NO crea factura', async () => {
    const deps = depsSolicitudes();
    const { repo, procesadas } = repoFalso([
      { id: 11, chat_id: '1', texto: '/cliente-nuevo 78.123.456-7 pagos@fulano.cl Constructora Fulano SpA' },
    ]);
    const { canal, mensajes } = canalColector();

    const r = await ejecutarProcesarSolicitudes(deps, repo, canal);

    expect(r.clientesCreados).toEqual(['CLI-023']);
    expect(r.procesadas).toEqual([]);
    expect(await deps.store.listarFacturaIds()).toEqual([]);
    expect(procesadas).toEqual([{ id: 11, facturaId: 'CLIENTE:CLI-023' }]);

    const fila = (deps.excel.agregarFilaClientes as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(fila).toMatchObject({
      cliente_id: 'CLI-023',
      razon_social: 'Constructora Fulano SpA',
      nombre_carpeta: 'Constructora Fulano SpA',
      rut_cliente: '78123456-7',
      email_facturacion: 'pagos@fulano.cl',
      activo: 'TRUE',
    });
    // El padrón del SII los completa al emitir; el libro es solo respaldo.
    expect(fila).toMatchObject({ giro: '', direccion: '', comuna: '', ciudad: '' });
    expect(mensajes[0]).toContain('Constructora Fulano SpA');
    expect(mensajes[0]).toContain('/factura CLI-023');
  });

  // Un RUT duplicado rompería resolverCliente por ambigüedad y dejaría al
  // operador sin poder facturarle a ninguno de los dos.
  it('rechaza un RUT que ya está en el libro y dice con qué cliente facturar', async () => {
    const deps = depsSolicitudes();
    const { repo, rechazadas } = repoFalso([
      { id: 12, chat_id: '1', texto: '/cliente-nuevo 78.264.318-5 otro@correo.cl Otra Razon SpA' },
    ]);
    const { canal, mensajes } = canalColector();

    const r = await ejecutarProcesarSolicitudes(deps, repo, canal);

    expect(r.clientesCreados).toEqual([]);
    expect(rechazadas[0]?.error).toContain('CLI-022');
    expect(mensajes[0]).toContain('/factura CLI-022');
    expect(deps.excel.agregarFilaClientes as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('un RUT con dígito verificador equivocado no llega al libro', async () => {
    const deps = depsSolicitudes();
    const { repo } = repoFalso([
      { id: 13, chat_id: '1', texto: '/cliente-nuevo 78123456-9 x@y.cl Empresa Equivocada' },
    ]);
    const { canal, mensajes } = canalColector();

    await ejecutarProcesarSolicitudes(deps, repo, canal);

    expect(deps.excel.agregarFilaClientes as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(mensajes[0]).toMatch(/RUT inv[áa]lido/i);
  });

  // Las dos pueden llegar seguidas y el libro se lee una sola vez por lote.
  it('una /factura del mismo lote ya ve al cliente recién dado de alta', async () => {
    const deps = depsSolicitudes();
    const { repo } = repoFalso([
      { id: 14, chat_id: '1', texto: '/cliente-nuevo 78.123.456-7 pagos@fulano.cl Constructora Fulano SpA' },
      { id: 15, chat_id: '1', texto: '/factura CLI-023 450000 Asesoría puntual' },
    ]);
    const { canal } = canalColector();

    const r = await ejecutarProcesarSolicitudes(deps, repo, canal);

    expect(r.clientesCreados).toEqual(['CLI-023']);
    expect(r.procesadas).toEqual(['PUNTUAL:E1:CLI-023:2026-07-26:15']);
    expect(r.rechazadas).toEqual([]);
  });
});
