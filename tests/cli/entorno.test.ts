// tests/cli/entorno.test.ts
// La decisión local-vs-nube de armarDependencias es la bisagra de todo el
// agente: estos tests fijan qué implementaciones se eligen según el entorno.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { armarDependencias, esNube, esNubeSupabase, RAIZ, type Entorno } from '../../src/cli/entorno.js';
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

describe('esNube', () => {
  it('Cloudflare exige URL y token, y tiene prioridad sobre Supabase', () => {
    process.env.SUPABASE_URL = 'https://x.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'llave';
    process.env.CF_API_URL = 'https://agente.workers.dev';
    expect(esNubeSupabase()).toBe(true);
    process.env.CF_API_TOKEN = 'token';
    expect(esNube()).toBe(true);
    expect(esNubeSupabase()).toBe(false);
  });

  it('exige AMBAS credenciales del service role', () => {
    delete process.env.CF_API_URL;
    delete process.env.CF_API_TOKEN;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(esNube()).toBe(false);
    process.env.SUPABASE_URL = 'https://x.supabase.co';
    expect(esNube()).toBe(false);
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'llave';
    expect(esNube()).toBe(true);
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

  it('en modo nube Supabase (respaldo) elige AuditStoreSupabase, AlmacenPdfSupabase y Graph app-only', async () => {
    process.env.AGENTE_CONFIG_JSON = CONFIG_PRUEBA;
    delete process.env.CF_API_URL;
    delete process.env.CF_API_TOKEN;
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
