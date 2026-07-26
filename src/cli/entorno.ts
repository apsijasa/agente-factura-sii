// src/cli/entorno.ts
// Armado del entorno de ejecución (local vs nube) y ciclo de vida de cada
// comando. Extraído de index.ts (hallazgo graphify 2026-07-26: cohesión 0.06)
// para que la selección de modo sea un módulo propio y testeable, e index.ts
// quede solo con la definición de comandos.
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { userInfo } from 'node:os';
import { createClient } from '@supabase/supabase-js';
import { cargarConfig, type Config } from '../config/config.js';
import { leerSecretoKeychain, obtenerOCrearClaveCifrado } from '../config/keychain.js';
import { crearCachePluginCifrado } from '../adapters/graph/token-cache.js';
import { normalizarRut } from '../domain/rut.js';
import { preflight } from '../config/preflight.js';
import {
  crearAutenticadorClientCredentials, crearAutenticadorDeviceCode, GraphClient,
} from '../adapters/graph/graph-client.js';
import { ExcelAdapter } from '../adapters/excel/excel-adapter.js';
import { UfProvider } from '../adapters/uf/uf-provider.js';
import { SiiAdapterPlaywright } from '../adapters/sii/sii-adapter.js';
import { MailService } from '../services/correo.js';
import { AlmacenPdfLocal, AlmacenPdfSupabase } from '../services/almacen-pdf.js';
import { ApprovalService } from '../services/aprobacion.js';
import type { IAuditStore } from '../store/audit-store.js';
import { AuditStoreSupabase } from '../store/audit-store-supabase.js';
import { FacturasRepository } from '../store/facturas-repository.js';
import { conBloqueo } from './lock.js';
import type { Dependencias } from './comandos.js';
import { logger } from '../services/logger.js';

export const RAIZ = process.cwd();

// Modo nube: la auditoría vive en Supabase y los PDFs en su bucket privado.
// Se activa solo con las credenciales del service role presentes en el entorno.
export const esNube = (): boolean =>
  Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

// Cache de tokens Microsoft cifrado (la llave vive en el llavero): evita
// repetir el código de dispositivo en cada comando.
export function cachePluginMsal(rutaDatos: string) {
  return crearCachePluginCifrado(join(rutaDatos, 'msal-cache.enc'), () => obtenerOCrearClaveCifrado());
}

type Readline = ReturnType<typeof createInterface>;

export interface Entorno {
  deps: Dependencias;
  repo: FacturasRepository;
  rutEmisor: string;
  graph: GraphClient;
  config: Config;
  rutaDatos: string;
  rl: Readline;
  appOnly: boolean;
}

export async function armarDependencias(): Promise<Entorno> {
  const config = await cargarConfig(RAIZ);
  const rutaDatos = join(RAIZ, config.rutaDatos);
  await mkdir(rutaDatos, { recursive: true });
  const appOnly = Boolean(process.env.GRAPH_CLIENT_SECRET);
  const graph = new GraphClient(
    appOnly
      ? crearAutenticadorClientCredentials({
          tenantId: config.tenantId,
          clientId: config.clientId,
          clientSecret: process.env.GRAPH_CLIENT_SECRET as string,
        })
      : crearAutenticadorDeviceCode({ ...config, cachePlugin: cachePluginMsal(rutaDatos) }),
  );
  const excel = new ExcelAdapter(graph, config);
  const supabase = esNube()
    ? createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_SERVICE_ROLE_KEY as string)
    : null;
  // Hallazgo graphify 2026-07-26: better-sqlite3 es un módulo NATIVO que la nube
  // no usa; el import dinámico evita cargarlo (y depender de que compile en el
  // runner) cuando el store es Supabase.
  const store: IAuditStore = supabase
    ? new AuditStoreSupabase(supabase)
    : new (await import('../store/audit-store.js')).AuditStore(join(rutaDatos, 'agente.sqlite'));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const io = {
    pregunta: (mensaje: string) =>
      Promise.race([
        rl.question(mensaje),
        new Promise<string>((_, rechazar) =>
          setTimeout(() => rechazar(new Error('Aprobación expirada')), config.timeoutAprobacionMs),
        ),
      ]),
  };
  const deps: Dependencias = {
    store,
    excel,
    uf: new UfProvider(),
    sii: new SiiAdapterPlaywright({
      dirEvidencia: join(rutaDatos, 'evidence'),
      timeoutMs: config.timeoutSiiMs,
      ciudadEmisor: Object.values(config.emisores)[0]?.ciudadEmisor,
      rutOperador: config.rutOperador ? (normalizarRut(config.rutOperador) ?? undefined) : undefined,
      leerSecreto: () => leerSecretoKeychain(Object.keys(config.emisores)[0] as string),
      leerClaveFirma: () => leerSecretoKeychain(`${Object.keys(config.emisores)[0] as string}-firma`),
      headless: process.env.SII_HEADLESS === '1',
    }),
    correo: new MailService(graph, config.buzonPrincipal),
    aprobacion: new ApprovalService(io, () => new Date(), userInfo().username),
    clasificaciones: config.emisores,
    pdfs: supabase ? new AlmacenPdfSupabase(supabase) : new AlmacenPdfLocal(config.rutaRaizClientes),
    hoy: () => new Date().toISOString().slice(0, 10),
  };
  const primerEmisor = Object.keys(config.emisores)[0] as string;
  return { deps, repo: new FacturasRepository(store, excel), rutEmisor: primerEmisor, graph, config, rutaDatos, rl, appOnly };
}

export async function conEntorno(
  verificarGraph: boolean,
  fn: (deps: Dependencias, repo: FacturasRepository, entorno: Entorno) => Promise<void>,
): Promise<void> {
  const entorno = await armarDependencias();
  const { deps, repo, rutEmisor, graph, config, rutaDatos, rl, appOnly } = entorno;
  try {
    await conBloqueo(rutaDatos, async () => {
      const chequeo = await preflight(config, graph, rutEmisor, {
        verificarGraph,
        appOnly,
        verificarRutaClientes: !esNube(),
      });
      if (!chequeo.ok) {
        throw new Error(`Preflight falló:\n- ${chequeo.fallas.join('\n- ')}`);
      }
      await repo.reconciliar();
      // Recuperación: filas huérfanas en EMITIENDO (proceso caído en plena
      // emisión) pasan a REQUIERE_REVISION antes de permitir cualquier acción.
      const interrumpidas = await deps.store.marcarEmisionesInterrumpidas();
      for (const facturaId of interrumpidas) {
        logger.warn(`Emisión interrumpida detectada: ${facturaId}; marcada REQUIERE_REVISION`);
        await repo.reflejar(facturaId, {
          estado: 'REQUIERE_REVISION',
          error:
            'emisión interrumpida por caída del proceso; verificar documentos emitidos en el SII antes de cualquier acción',
        });
      }
      try {
        await fn(deps, repo, entorno);
      } finally {
        await deps.sii.cerrar();
        await deps.store.cerrar();
      }
    });
  } finally {
    // Sin este cierre, readline mantiene vivo el proceso tras cada comando.
    rl.close();
  }
}
