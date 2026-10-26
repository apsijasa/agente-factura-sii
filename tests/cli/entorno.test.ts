// tests/cli/entorno.test.ts
// La decisión local-vs-nube de armarDependencias es la bisagra de todo el
// agente: estos tests fijan qué implementaciones se eligen según el entorno.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { armarDependencias, esNube, esNubeCloudflare, esNubeSupabase, RAIZ, type Entorno } from '../../src/cli/entorno.js';
import { AuditStore } from '../../src/store/audit-store.js';
import { AuditStoreSupabase } from '../../src/store/audit-store-supabase.js';
import { AlmacenPdfLocal, AlmacenPdfR2, AlmacenPdfSupabase } from '../../src/services/almacen-pdf.js';
import { AuditStoreCloudflare } from '../../src/store/audit-store-cloudflare.js';
import { SolicitudesCloudflare } from '../../src/store/solicitudes-cloudflare.js';

const RUTA_DATOS_PRUEBA = `.data-prueba-entorno-${process.pid}`;

const CONFIG_PRUEBA = JSON.stringify({
  tenantId: 'tenant-prueba',
  clientId: 'client-prueba',
  buzonPrincipal: 'buzon@empresa.cl',
  driveId: 'D1',
  itemId: 'I1',
  rutaRaizClientes: '/tmp/clientes-prueba',
  rutaDatos: RUTA_DATOS_PRUEBA,
  modoPredeterminado: 'simulation',
  emisores: { 'EMP-1': { tipoVenta: 'Del Giro', tipoCompra: 'Del Giro' } },
});

const CLAVES_ENTORNO = [
  'AGENTE_CONFIG_JSON', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GRAPH_CLIENT_SECRET', 'CF_API_URL', 'CF_API_TOKEN',
  'AGENTE_MODO',
] as const;
const respaldo = Object.fromEntries(CLAVES_ENTORNO.map((k) => [k, process.env[k]]));

async function cerrar(entorno: Entorno): Promise<void> {
  entorno.rl.close();
  await entorno.deps.store.cerrar();
}

afterEach(() => {
  for (const k of CLAVES_ENTORNO) {
    if (respaldo[k] === undefined) delete process.env[k];
    else process.env[k] = respaldo[k];
  }
});

afterAll(() => {
  rmSync(join(RAIZ, RUTA_DATOS_PRUEBA), { recursive: true, force: true });
});

function limpiarNube(): void {
  for (const k of ['CF_API_URL', 'CF_API_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'AGENTE_MODO']) delete process.env[k];
}

// Perder media credencial no puede degradar en silencio a otra fuente de
// verdad: para documentos tributarios, operar contra la copia equivocada sin
// un error es peor que no operar.
describe('esNube', () => {
  it('Cloudflare con el par completo tiene prioridad sobre Supabase', () => {
    limpiarNube();
    process.env.SUPABASE_URL = 'https://x.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'llave';
    process.env.CF_API_URL = 'https://agente.workers.dev';
    process.env.CF_API_TOKEN = 'token';
    expect(esNubeCloudflare()).toBe(true);
    expect(esNubeSupabase()).toBe(false);
    expect(esNube()).toBe(true);
  });

  it('con media credencial de Cloudflare lanza nombrando la que falta, en vez de caer a otro modo', () => {
    limpiarNube();
    process.env.CF_API_URL = 'https://agente.workers.dev';
    process.env.SUPABASE_URL = 'https://x.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'llave';
    expect(() => esNube()).toThrow(/falta CF_API_TOKEN/);
    limpiarNube();
    process.env.CF_API_TOKEN = 'token';
    expect(() => esNube()).toThrow(/falta CF_API_URL/);
  });

  it('Supabase nunca se elige por omisión: con sus credenciales y sin Cloudflare lanza pidiendo AGENTE_MODO', () => {
    limpiarNube();
    process.env.SUPABASE_URL = 'https://x.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'llave';
    expect(() => esNube()).toThrow(/AGENTE_MODO=supabase/);
  });

  it('AGENTE_MODO=supabase activa el plan B y exige su par completo', () => {
    limpiarNube();
    process.env.AGENTE_MODO = 'supabase';
    process.env.SUPABASE_URL = 'https://x.supabase.co';
    expect(() => esNube()).toThrow(/falta SUPABASE_SERVICE_ROLE_KEY/);
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'llave';
    process.env.CF_API_URL = 'https://agente.workers.dev';
    process.env.CF_API_TOKEN = 'token';
    expect(esNubeSupabase()).toBe(true);
    expect(esNubeCloudflare()).toBe(false);
  });

  it('un AGENTE_MODO desconocido lanza, y sin ninguna credencial es modo local', () => {
    limpiarNube();
    process.env.AGENTE_MODO = 'cloudflare';
    expect(() => esNube()).toThrow(/AGENTE_MODO desconocido/);
    limpiarNube();
    expect(esNube()).toBe(false);
  });
});

describe('armarDependencias', () => {
  it('en modo nube Cloudflare elige D1 (vía Worker), R2 y solicitudes de Telegram', async () => {
    process.env.AGENTE_CONFIG_JSON = CONFIG_PRUEBA;
    process.env.CF_API_URL = 'https://agente.workers.dev';
    process.env.CF_API_TOKEN = 'token-de-prueba';
    process.env.SUPABASE_URL = 'https://prueba.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'llave-de-prueba';
    process.env.GRAPH_CLIENT_SECRET = 'secreto-de-prueba';

    const entorno = await armarDependencias();
    try {
      expect(entorno.deps.store).toBeInstanceOf(AuditStoreCloudflare);
      expect(entorno.deps.pdfs).toBeInstanceOf(AlmacenPdfR2);
      expect(entorno.solicitudes).toBeInstanceOf(SolicitudesCloudflare);
      expect(entorno.supabase).toBeNull();
    } finally {
      await cerrar(entorno);
    }
  });

  it('en modo nube Supabase (plan B explícito) elige AuditStoreSupabase, AlmacenPdfSupabase y Graph app-only', async () => {
    process.env.AGENTE_CONFIG_JSON = CONFIG_PRUEBA;
    delete process.env.CF_API_URL;
    delete process.env.CF_API_TOKEN;
    process.env.AGENTE_MODO = 'supabase';
    process.env.SUPABASE_URL = 'https://prueba.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'llave-de-prueba';
    process.env.GRAPH_CLIENT_SECRET = 'secreto-de-prueba';

    const entorno = await armarDependencias();
    try {
      expect(entorno.deps.store).toBeInstanceOf(AuditStoreSupabase);
      expect(entorno.deps.pdfs).toBeInstanceOf(AlmacenPdfSupabase);
      expect(entorno.appOnly).toBe(true);
      expect(entorno.rutEmisor).toBe('EMP-1');
    } finally {
      await cerrar(entorno);
    }
  });

  it('sin credenciales de nube elige SQLite local y almacén de disco', async () => {
    process.env.AGENTE_CONFIG_JSON = CONFIG_PRUEBA;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.GRAPH_CLIENT_SECRET;
    delete process.env.CF_API_URL;
    delete process.env.CF_API_TOKEN;

    const entorno = await armarDependencias();
    try {
      expect(entorno.deps.store).toBeInstanceOf(AuditStore);
      expect(entorno.deps.pdfs).toBeInstanceOf(AlmacenPdfLocal);
      expect(entorno.appOnly).toBe(false);
    } finally {
      await cerrar(entorno);
    }
  });
});
