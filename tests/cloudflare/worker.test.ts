// tests/cloudflare/worker.test.ts
// El Worker que reemplaza a las Edge Functions y RPC de Supabase, ejecutado
// contra D1 emulada (better-sqlite3) y R2 en memoria.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { crearToken } from '../../src/services/token-aprobacion.js';
import { AuditStoreCloudflare } from '../../src/store/audit-store-cloudflare.js';
import { SolicitudesCloudflare } from '../../src/store/solicitudes-cloudflare.js';
import { AlmacenPdfR2, PREFIJO_R2, PREFIJO_SUPABASE } from '../../src/services/almacen-pdf.js';
import { ErrorApiCloudflare } from '../../src/store/api-cloudflare.js';
import { registrarTransicion } from '../../cloudflare/src/index.js';
import { crearCloudflareFalso, TOKEN_PRUEBA } from '../store/cloudflare-falso.js';
import type { InvoicePayload } from '../../src/domain/tipos.js';

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');

const payload = {
  factura_id: 'PUNTUAL:E1:CL1:1',
  lineas: [
    { cobro_id: 'C1', descripcion: 'Servicio', moneda: 'CLP', monto_neto_original: 100000, cantidad: 1, precio_unitario_clp: 100000, total_linea_clp: 100000 },
  ],
} as unknown as InvoicePayload;

async function facturaPendiente() {
  const cf = crearCloudflareFalso();
  const store = new AuditStoreCloudflare(cf.api);
  await store.crearFactura(payload, 'hash-1');
  await store.registrarTransicion(payload.factura_id, 'PENDIENTE_APROBACION', 'preparación');
  return { ...cf, store };
}

const enlace = (datos: { facturaId: string; payloadHash: string; expiraEn: string }, secreto = 'secreto-aprobacion') =>
  `https://agente.test/aprobar?token=${crearToken(datos, secreto)}`;
const enUnaHora = () => new Date(Date.now() + 3_600_000).toISOString();

afterEach(() => vi.unstubAllGlobals());

describe('Worker /aprobar', () => {
  it('registra la aprobación remota con el hash del enlace y la factura queda en el gate', async () => {
    const { llamarWorker, store, api } = await facturaPendiente();
    const res = await llamarWorker(enlace({ facturaId: payload.factura_id, payloadHash: 'hash-1', expiraEn: enUnaHora() }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Factura aprobada');
    expect(await store.obtenerAprobacion(payload.factura_id)).toMatchObject({ actor: 'aprobacion-remota', payload_hash: 'hash-1' });
    const gate = await (await llamarWorker('https://agente.test/api/gate/aprobadas-pendientes', {
      headers: { Authorization: `Bearer ${TOKEN_PRUEBA}` },
    })).json();
    expect(gate).toEqual([{ factura_id: payload.factura_id }]);
    expect(api).toBeDefined();
  });

  it('rechaza (409) si el contenido cambió después de la notificación, sin aprobar nada', async () => {
    const { llamarWorker, store } = await facturaPendiente();
    const res = await llamarWorker(enlace({ facturaId: payload.factura_id, payloadHash: 'hash-viejo', expiraEn: enUnaHora() }));
    expect(res.status).toBe(409);
    expect(await store.obtenerAprobacion(payload.factura_id)).toBeUndefined();
  });

  it('rechaza enlaces vencidos o con firma de otro secreto', async () => {
    const { llamarWorker, store } = await facturaPendiente();
    const vencido = await llamarWorker(enlace({ facturaId: payload.factura_id, payloadHash: 'hash-1', expiraEn: '2020-01-01T00:00:00Z' }));
    expect(vencido.status).toBe(400);
    expect(await vencido.text()).toContain('expiró');
    const falsificado = await llamarWorker(
      enlace({ facturaId: payload.factura_id, payloadHash: 'hash-1', expiraEn: enUnaHora() }, 'otro-secreto'),
    );
    expect(falsificado.status).toBe(400);
    expect(await store.obtenerAprobacion(payload.factura_id)).toBeUndefined();
  });

  // El cliente_id lo escribe una persona en el Excel y nada le exige ASCII.
  // El firmante en Node codifica el cuerpo del token en UTF-8; si el Worker lo
  // decodifica con atob() a secas obtiene latin1 ("ASESORÃ\u008dA"), la firma
  // valida igual y el SELECT no encuentra la fila: 404 y enlace roto para siempre.
  it('aprueba una factura cuyo factura_id lleva tilde (el cuerpo del token se lee como UTF-8)', async () => {
    const cf = crearCloudflareFalso();
    const store = new AuditStoreCloudflare(cf.api);
    const acentuada = { ...payload, factura_id: 'RECURRENT:ACME:ASESORÍA LTDA:2026-10' } as InvoicePayload;
    await store.crearFactura(acentuada, 'hash-1');
    await store.registrarTransicion(acentuada.factura_id, 'PENDIENTE_APROBACION', 'preparación');
    const res = await cf.llamarWorker(enlace({ facturaId: acentuada.factura_id, payloadHash: 'hash-1', expiraEn: enUnaHora() }));
    expect(res.status).toBe(200);
    expect(await store.obtenerAprobacion(acentuada.factura_id)).toMatchObject({ actor: 'aprobacion-remota', payload_hash: 'hash-1' });
  });

  it('no tiene efecto si la factura ya no espera aprobación', async () => {
    const cf = crearCloudflareFalso();
    const store = new AuditStoreCloudflare(cf.api);
    await store.crearFactura(payload, 'hash-1'); // queda en BORRADOR
    const res = await cf.llamarWorker(enlace({ facturaId: payload.factura_id, payloadHash: 'hash-1', expiraEn: enUnaHora() }));
    expect(await res.text()).toContain('Sin efecto');
    expect(await store.obtenerAprobacion(payload.factura_id)).toBeUndefined();
  });
});

describe('Worker /telegram-webhook', () => {
  const cuerpo = (texto: string, chat = '42') => JSON.stringify({ message: { text: texto, chat: { id: Number(chat) } } });

  it('exige el secreto del webhook', async () => {
    const { llamarWorker } = crearCloudflareFalso({ TELEGRAM_WEBHOOK_SECRET: 's3', TELEGRAM_CHAT_ID: '42' });
    const res = await llamarWorker('https://agente.test/telegram-webhook', { method: 'POST', body: cuerpo('/factura X 1 y') });
    expect(res.status).toBe(401);
  });

  it('guarda /factura del chat autorizado e ignora otros chats en silencio', async () => {
    const telegram = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', telegram);
    const cf = crearCloudflareFalso({ TELEGRAM_WEBHOOK_SECRET: 's3', TELEGRAM_CHAT_ID: '42', TELEGRAM_BOT_TOKEN: 'bot' });
    const headers = { 'x-telegram-bot-api-secret-token': 's3' };
    await cf.llamarWorker('https://agente.test/telegram-webhook', { method: 'POST', headers, body: cuerpo('/factura CLI-022 250000 Asesoría') });
    await cf.llamarWorker('https://agente.test/telegram-webhook', { method: 'POST', headers, body: cuerpo('/factura intruso', '99') });
    const solicitudes = new SolicitudesCloudflare(cf.api);
    const pendientes = await solicitudes.pendientes();
    expect(pendientes).toEqual([{ id: 1, chat_id: '42', texto: '/factura CLI-022 250000 Asesoría' }]);
    expect(telegram).toHaveBeenCalledTimes(1); // solo responde al chat autorizado

    await solicitudes.marcarProcesada(1, 'PUNTUAL:X');
    expect(await solicitudes.pendientes()).toEqual([]);
    const fila = cf.db.prepare('SELECT estado, factura_id FROM solicitudes_facturas WHERE id = 1').get();
    expect(fila).toEqual({ estado: 'PROCESADA', factura_id: 'PUNTUAL:X' });
  });
});

describe('Worker /api', () => {
  it('rechaza llamadas sin el token del agente', async () => {
    const { llamarWorker } = crearCloudflareFalso();
    const res = await llamarWorker('https://agente.test/api/query', {
      method: 'POST',
      headers: { Authorization: 'Bearer otro' },
      body: JSON.stringify({ sql: 'SELECT 1' }),
    });
    expect(res.status).toBe(401);
  });

  it('el compare-and-swap no deja evento ni cambia estado si el estado leído ya no es el actual', async () => {
    const { env, store } = await facturaPendiente();
    // Otro proceso ya movió la factura: se intenta transicionar desde un estado viejo.
    const r = await registrarTransicion(env.DB, payload.factura_id, 'BORRADOR', 'PENDIENTE_APROBACION', 'carrera');
    expect(r).toBe('TRANSICION_CONCURRENTE');
    expect((await store.obtenerFactura(payload.factura_id))?.estado).toBe('PENDIENTE_APROBACION');
    expect((await store.obtenerEventos(payload.factura_id)).map((e) => e.detalle)).toEqual(['creación', 'preparación']);
  });

  it('crear factura duplicada no deja filas a medias', async () => {
    const { store, db } = await facturaPendiente();
    await expect(store.crearFactura(payload, 'hash-2')).rejects.toThrow('ya existe');
    expect(db.prepare('SELECT count(*) n FROM invoice_lines').get()).toEqual({ n: 1 });
  });
});

describe('AlmacenPdfR2', () => {
  it('sube con la clave relativa, devuelve r2:// y jamás sobrescribe un folio', async () => {
    const { api, objetos } = crearCloudflareFalso();
    const almacen = new AlmacenPdfR2(api);
    const ruta = await almacen.guardarFactura('NCA', '2026-07-24', '35', PDF);
    expect(ruta).toBe(`${PREFIJO_R2}NCA/2026/07/Factura_35_NCA_2026-07.pdf`);
    expect(objetos.get('NCA/2026/07/Factura_35_NCA_2026-07.pdf')?.equals(PDF)).toBe(true);
    await expect(almacen.guardarFactura('NCA', '2026-07-24', '35', PDF)).rejects.toBeInstanceOf(ErrorApiCloudflare);
  });

  it('relee rutas nuevas y las históricas supabase:// migradas con la misma clave', async () => {
    const { api, objetos } = crearCloudflareFalso();
    objetos.set('SOCIEDAD MMP/2026/09/Factura_68_SOCIEDAD MMP_2026-09.pdf', PDF);
    const almacen = new AlmacenPdfR2(api);
    const datos = await almacen.obtener(`${PREFIJO_SUPABASE}SOCIEDAD MMP/2026/09/Factura_68_SOCIEDAD MMP_2026-09.pdf`);
    expect(datos.equals(PDF)).toBe(true);
  });

  it('rechaza contenido que no es PDF antes de subirlo', async () => {
    const { api, objetos } = crearCloudflareFalso();
    await expect(new AlmacenPdfR2(api).guardarFactura('NCA', '2026-07-24', '35', Buffer.from('hola'))).rejects.toThrow('no es un PDF');
    expect(objetos.size).toBe(0);
  });
});
