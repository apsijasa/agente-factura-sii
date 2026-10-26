// cloudflare/src/index.ts
// Worker único que reemplaza a Supabase en modo nube:
//   GET  /aprobar             — enlace de aprobación remota (ex Edge Function `aprobar`)
//   POST /telegram-webhook    — bot de Telegram /factura (ex Edge Function `telegram-webhook`)
//   /api/*                    — API privada del agente (Bearer AGENT_API_TOKEN):
//       POST /api/query                 consulta parametrizada contra D1
//       POST /api/crear-factura         ex RPC crear_factura (atómica)
//       POST /api/registrar-transicion  ex RPC registrar_transicion (compare-and-swap atómico)
//       GET  /api/gate/aprobadas-pendientes | /api/gate/solicitudes-nuevas  (chequeos baratos de los workflows)
//       PUT/GET /api/pdf?key=...        PDFs en R2 (ex bucket privado `facturas`; PUT nunca sobrescribe)
// Los tipos de D1/R2 se declaran mínimos aquí para no depender de
// @cloudflare/workers-types y poder probar este archivo con vitest.

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  meta: { changes: number; last_row_id?: number };
}
export interface D1PreparedStatement {
  bind(...valores: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<D1Result>;
}
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(sentencias: D1PreparedStatement[]): Promise<D1Result[]>;
}
export interface R2ObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface R2PutOptions {
  /** Precondición evaluada por R2 en el servidor; con `etagDoesNotMatch: '*'` el put falla (devuelve null) si la clave ya existe. */
  onlyIf?: { etagDoesNotMatch?: string };
  httpMetadata?: { contentType?: string };
}
export interface R2Bucket {
  head(clave: string): Promise<unknown | null>;
  get(clave: string): Promise<R2ObjectBody | null>;
  put(clave: string, datos: ArrayBuffer, opciones?: R2PutOptions): Promise<unknown | null>;
}

export interface Env {
  DB: D1Database;
  PDFS: R2Bucket;
  AGENT_API_TOKEN: string;
  APPROVAL_SECRET: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

// ---------------------------------------------------------------- utilidades

const ahoraIso = (): string => new Date().toISOString();

function json(cuerpo: unknown, estado = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status: estado,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function igualesTiempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let distinto = 0;
  for (let i = 0; i < a.length; i++) distinto |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return distinto === 0;
}

function escaparHtml(texto: string): string {
  return texto.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

// ---------------------------------------------------------------- /aprobar

interface DatosToken {
  facturaId: string;
  payloadHash: string;
  expiraEn: string;
}

function aBase64Url(bytes: ArrayBuffer): string {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function verificarToken(token: string, secreto: string, ahora = Date.now()): Promise<DatosToken> {
  const partes = token.split('.');
  if (partes.length !== 2 || !partes[0] || !partes[1]) throw new Error('Token inválido (formato)');
  const [cuerpo, firma] = partes as [string, string];
  const clave = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secreto),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const esperada = aBase64Url(await crypto.subtle.sign('HMAC', clave, new TextEncoder().encode(cuerpo)));
  if (!igualesTiempoConstante(esperada, firma)) throw new Error('Token inválido (firma)');
  let datos: DatosToken;
  try {
    // atob() entrega latin1 y el firmante (Node, Buffer.toString()) escribió
    // UTF-8: con un factura_id acentuado ambos divergen aunque la firma valide,
    // y el SELECT no encuentra la fila. Se decodifica a bytes y recién ahí a texto.
    const bin = atob(cuerpo.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    datos = JSON.parse(new TextDecoder().decode(bytes)) as DatosToken;
  } catch {
    throw new Error('Token inválido (contenido)');
  }
  if (!datos.facturaId || !datos.payloadHash || !datos.expiraEn) throw new Error('Token inválido (campos)');
  if (ahora > new Date(datos.expiraEn).getTime()) {
    throw new Error('El enlace expiró; espere la próxima notificación del agente');
  }
  return datos;
}

function html(titulo: string, cuerpo: string, estado = 200): Response {
  return new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titulo}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 24px;color:#1a1a1a}
h1{font-size:1.4rem}p{line-height:1.5;color:#444}.ok{color:#0a7d40}.err{color:#b00020}</style>
</head><body>${cuerpo}</body></html>`,
    { status: estado, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

async function aprobar(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'GET') return html('Método no permitido', '<h1 class="err">Método no permitido</h1>', 405);
  const token = new URL(req.url).searchParams.get('token') ?? '';
  if (!env.APPROVAL_SECRET) return html('Configuración', '<h1 class="err">Falta APPROVAL_SECRET en el Worker</h1>', 500);

  let datos: DatosToken;
  try {
    datos = await verificarToken(token, env.APPROVAL_SECRET);
  } catch (e) {
    return html('Enlace inválido', `<h1 class="err">Enlace inválido</h1><p>${escaparHtml((e as Error).message)}.</p>`, 400);
  }

  const fila = await env.DB.prepare('SELECT estado, payload_hash FROM invoice_runs WHERE factura_id = ?')
    .bind(datos.facturaId)
    .first<{ estado: string; payload_hash: string }>();
  if (!fila) return html('No encontrada', '<h1 class="err">Factura no encontrada</h1>', 404);
  if (fila.estado !== 'PENDIENTE_APROBACION') {
    return html(
      'Sin efecto',
      `<h1>Sin efecto</h1><p>La factura está en estado <b>${escaparHtml(fila.estado)}</b>; ya no espera aprobación.</p>`,
    );
  }
  if (fila.payload_hash !== datos.payloadHash) {
    return html(
      'Contenido cambió',
      '<h1 class="err">El contenido de la factura cambió después de esta notificación</h1>' +
        '<p>Por seguridad no se aprobó nada. El agente enviará una nueva solicitud con los datos vigentes.</p>',
      409,
    );
  }

  await env.DB.prepare(
    `INSERT INTO approvals (factura_id, actor, payload_hash, aprobado_en) VALUES (?, ?, ?, ?)
     ON CONFLICT(factura_id) DO UPDATE SET actor = excluded.actor, payload_hash = excluded.payload_hash, aprobado_en = excluded.aprobado_en`,
  )
    .bind(datos.facturaId, 'aprobacion-remota', datos.payloadHash, ahoraIso())
    .run();

  return html(
    'Factura aprobada',
    `<h1 class="ok">✓ Factura aprobada</h1>
<p><b>${escaparHtml(datos.facturaId)}</b></p>
<p>El agente la emitirá en el SII en su próximo ciclo (máximo 30 minutos) y enviará el PDF al cliente automáticamente.</p>`,
  );
}

// ---------------------------------------------------------------- /telegram-webhook

const AYUDA =
  'Comandos disponibles:\n' +
  '/factura <cliente> <monto> <descripción>\n\n' +
  'Ejemplos:\n' +
  '/factura CLI-022 250000 Asesoría contable julio\n' +
  '/factura "SOCIEDAD PM" 250000 Asesoría contable\n' +
  '/factura CLI-025 33,5UF Consultoría especial\n\n' +
  'El monto es NETO (sin IVA). El agente valida el cliente, calcula el IVA y te ' +
  'envía el resumen con el enlace de aprobación antes de emitir nada.';

async function responderTelegram(env: Env, chatId: string, texto: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: texto }),
  }).catch(() => undefined);
}

async function telegramWebhook(req: Request, env: Env): Promise<Response> {
  // Telegram reintenta ante no-200: siempre respondemos 200 salvo auth inválida.
  if (req.method !== 'POST') return new Response('ok');
  const esperado = env.TELEGRAM_WEBHOOK_SECRET;
  const recibido = req.headers.get('x-telegram-bot-api-secret-token') ?? '';
  if (!esperado || !igualesTiempoConstante(recibido, esperado)) {
    return new Response('no autorizado', { status: 401 });
  }

  let update: { message?: { text?: string; chat?: { id?: number | string } } };
  try {
    update = await req.json();
  } catch {
    return new Response('ok');
  }
  const texto = update.message?.text?.trim() ?? '';
  const chatId = String(update.message?.chat?.id ?? '');
  // Mensajes de chats no autorizados se ignoran en silencio (sin filtrar información).
  if (!texto || !env.TELEGRAM_CHAT_ID || chatId !== env.TELEGRAM_CHAT_ID) return new Response('ok');

  if (texto.startsWith('/factura')) {
    try {
      await env.DB.prepare('INSERT INTO solicitudes_facturas (chat_id, texto) VALUES (?, ?)').bind(chatId, texto).run();
      await responderTelegram(
        env,
        chatId,
        'Solicitud recibida ✓\n\nEl agente la validará en el próximo ciclo (máximo 30 minutos) y te enviará ' +
          'el resumen de la factura con su enlace de aprobación. Nada se emite sin tu aprobación.',
      );
    } catch (e) {
      await responderTelegram(env, chatId, `⚠️ No pude registrar la solicitud: ${(e as Error).message}`);
    }
    return new Response('ok');
  }

  if (texto === '/start' || texto === '/ayuda' || texto === '/help') {
    await responderTelegram(env, chatId, AYUDA);
    return new Response('ok');
  }

  await responderTelegram(env, chatId, `No entendí ese mensaje.\n\n${AYUDA}`);
  return new Response('ok');
}

// ---------------------------------------------------------------- /api (privada)

interface LineaPayload {
  cobro_id: string;
  descripcion: string;
  moneda: string;
  monto_neto_original: number;
  cantidad: number;
  precio_unitario_clp: number;
  total_linea_clp: number;
}

/** Ex RPC crear_factura: factura + líneas + evento de creación en UNA transacción (batch). */
export async function crearFactura(db: D1Database, payloadTexto: string, hash: string): Promise<'ok' | 'FACTURA_DUPLICADA'> {
  const payload = JSON.parse(payloadTexto) as { factura_id: string; lineas: LineaPayload[] };
  const id = payload.factura_id;
  const existe = await db.prepare('SELECT 1 AS x FROM invoice_runs WHERE factura_id = ?').bind(id).first();
  if (existe) return 'FACTURA_DUPLICADA';
  const sentencias = [
    db.prepare("INSERT INTO invoice_runs (factura_id, estado, payload_json, payload_hash) VALUES (?, 'BORRADOR', ?, ?)").bind(id, payloadTexto, hash),
    ...payload.lineas.map((l) =>
      db
        .prepare(
          `INSERT INTO invoice_lines (factura_id, cobro_id, descripcion, moneda, monto_neto_original, cantidad, precio_unitario_clp, total_linea_clp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, l.cobro_id, l.descripcion, l.moneda, l.monto_neto_original, l.cantidad, l.precio_unitario_clp, l.total_linea_clp),
    ),
    db.prepare("INSERT INTO state_events (factura_id, desde, hacia, detalle) VALUES (?, NULL, 'BORRADOR', 'creación')").bind(id),
  ];
  try {
    await db.batch(sentencias);
  } catch (e) {
    // Carrera entre el SELECT y el batch: la PK lo detecta y el batch se revierte entero.
    if (/UNIQUE constraint failed: invoice_runs\.factura_id/i.test((e as Error).message)) return 'FACTURA_DUPLICADA';
    throw e;
  }
  return 'ok';
}

/**
 * Ex RPC registrar_transicion: compare-and-swap atómico. El evento se inserta
 * SOLO si el estado actual es `desde`, y el UPDATE exige lo mismo; ambos van
 * en el mismo batch (transacción), así que o pasan los dos o ninguno.
 */
export async function registrarTransicion(
  db: D1Database,
  facturaId: string,
  desde: string,
  hacia: string,
  detalle: string,
): Promise<'ok' | 'TRANSICION_CONCURRENTE'> {
  const [insercion, actualizacion] = await db.batch([
    db
      .prepare(
        `INSERT INTO state_events (factura_id, desde, hacia, detalle)
         SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM invoice_runs WHERE factura_id = ? AND estado = ?)`,
      )
      .bind(facturaId, desde, hacia, detalle, facturaId, desde),
    db.prepare('UPDATE invoice_runs SET estado = ? WHERE factura_id = ? AND estado = ?').bind(hacia, facturaId, desde),
  ]);
  if (actualizacion?.meta.changes !== 1 || insercion?.meta.changes !== 1) return 'TRANSICION_CONCURRENTE';
  return 'ok';
}

function validarClavePdf(clave: string | null): string {
  if (!clave || clave.startsWith('/') || clave.includes('..') || !clave.endsWith('.pdf')) {
    throw new Error('clave de PDF inválida');
  }
  return clave;
}

async function api(req: Request, env: Env, ruta: string): Promise<Response> {
  const auth = req.headers.get('authorization') ?? '';
  if (!env.AGENT_API_TOKEN || !igualesTiempoConstante(auth, `Bearer ${env.AGENT_API_TOKEN}`)) {
    return json({ error: 'no autorizado' }, 401);
  }
  try {
    if (ruta === '/api/query' && req.method === 'POST') {
      const { sql, params } = (await req.json()) as { sql: string; params?: unknown[] };
      const r = await env.DB.prepare(sql).bind(...(params ?? [])).all();
      return json({ results: r.results, changes: r.meta.changes });
    }
    if (ruta === '/api/crear-factura' && req.method === 'POST') {
      const { payload, hash } = (await req.json()) as { payload: string; hash: string };
      const r = await crearFactura(env.DB, payload, hash);
      return r === 'ok' ? json({ ok: true }) : json({ error: r }, 409);
    }
    if (ruta === '/api/registrar-transicion' && req.method === 'POST') {
      const b = (await req.json()) as { factura_id: string; desde: string; hacia: string; detalle: string };
      const r = await registrarTransicion(env.DB, b.factura_id, b.desde, b.hacia, b.detalle);
      return r === 'ok' ? json({ ok: true }) : json({ error: r }, 409);
    }
    if (ruta === '/api/gate/aprobadas-pendientes' && req.method === 'GET') {
      const r = await env.DB.prepare('SELECT factura_id FROM facturas_aprobadas_pendientes ORDER BY factura_id').all();
      return json(r.results);
    }
    if (ruta === '/api/gate/solicitudes-nuevas' && req.method === 'GET') {
      const r = await env.DB.prepare("SELECT id FROM solicitudes_facturas WHERE estado = 'NUEVA' ORDER BY id").all();
      return json(r.results);
    }
    if (ruta === '/api/pdf') {
      const clave = validarClavePdf(new URL(req.url).searchParams.get('key'));
      if (req.method === 'PUT') {
        const datos = await req.arrayBuffer();
        const cabecera = new TextDecoder('latin1').decode(new Uint8Array(datos).subarray(0, 5));
        if (!cabecera.startsWith('%PDF')) return json({ error: 'El contenido no es un PDF' }, 400);
        // Equivalente a upsert:false — un folio confirmado jamás se sobrescribe.
        // La precondición la evalúa R2 en el mismo put: un `head` previo dejaba
        // una ventana en la que dos escritores podían pasar y "ganaba el último".
        const puesto = await env.PDFS.put(clave, datos, {
          onlyIf: { etagDoesNotMatch: '*' },
          httpMetadata: { contentType: 'application/pdf' },
        });
        if (puesto === null) return json({ error: 'YA_EXISTE' }, 409);
        return json({ ok: true, key: clave });
      }
      if (req.method === 'GET') {
        const obj = await env.PDFS.get(clave);
        if (!obj) return json({ error: 'NO_EXISTE' }, 404);
        return new Response(await obj.arrayBuffer(), { headers: { 'Content-Type': 'application/pdf' } });
      }
    }
    return json({ error: 'ruta no encontrada' }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

// ---------------------------------------------------------------- router

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const ruta = new URL(req.url).pathname.replace(/\/+$/, '') || '/';
    if (ruta === '/aprobar') return aprobar(req, env);
    if (ruta === '/telegram-webhook') return telegramWebhook(req, env);
    if (ruta.startsWith('/api/')) return api(req, env, ruta);
    return new Response('agente-factura-sii', { status: 404 });
  },
};
