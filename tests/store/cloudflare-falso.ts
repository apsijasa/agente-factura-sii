// tests/store/cloudflare-falso.ts
// Cloudflare FALSO pero fiel: ejecuta el Worker REAL (cloudflare/src/index.ts)
// contra una D1 emulada con better-sqlite3 (mismo SQLite, mismo esquema de
// la migración 0001) y un R2 en memoria. El `fetch` que recibe ApiCloudflare
// llama directo al handler del Worker, así que la suite de contrato prueba de
// punta a punta cliente → Worker → SQL, incluidos los batches atómicos.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import worker, {
  type D1Database, type D1PreparedStatement, type D1Result, type Env, type R2Bucket,
} from '../../cloudflare/src/index.js';
import { ApiCloudflare } from '../../src/store/api-cloudflare.js';

const ESQUEMA = readFileSync(join(import.meta.dirname, '../../cloudflare/migrations/0001_esquema_auditoria.sql'), 'utf8');

export function crearD1Falsa(): { d1: D1Database; db: Database.Database } {
  const db = new Database(':memory:');
  db.exec(ESQUEMA);

  const preparar = (sql: string, valores: unknown[] = []): D1PreparedStatement & { ejecutar(): D1Result } => {
    const ejecutar = (): D1Result => {
      const stmt = db.prepare(sql);
      if (stmt.reader) return { results: stmt.all(...valores) as Record<string, unknown>[], meta: { changes: 0 } };
      const r = stmt.run(...valores);
      return { results: [], meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
    };
    return {
      bind: (...v: unknown[]) => preparar(sql, v),
      ejecutar,
      all: async <T>() => ejecutar() as D1Result<T>,
      first: async <T>() => ((ejecutar().results[0] as T | undefined) ?? null),
      run: async () => ejecutar(),
    };
  };

  const d1: D1Database = {
    prepare: (sql) => preparar(sql),
    batch: async (sentencias) =>
      db.transaction(() => sentencias.map((s) => (s as ReturnType<typeof preparar>).ejecutar()))(),
  };
  return { d1, db };
}

export function crearR2Falso(): { r2: R2Bucket; objetos: Map<string, Buffer> } {
  const objetos = new Map<string, Buffer>();
  const r2: R2Bucket = {
    head: async (k) => (objetos.has(k) ? {} : null),
    get: async (k) => {
      const b = objetos.get(k);
      if (!b) return null;
      return { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
    },
    put: async (k, datos, opciones) => {
      // Misma semántica que R2: la precondición se decide en el put, no antes.
      if (opciones?.onlyIf?.etagDoesNotMatch === '*' && objetos.has(k)) return null;
      objetos.set(k, Buffer.from(datos));
      return {};
    },
  };
  return { r2, objetos };
}

export const TOKEN_PRUEBA = 'token-api-prueba';

export function crearCloudflareFalso(extra: Partial<Env> = {}) {
  const { d1, db } = crearD1Falsa();
  const { r2, objetos } = crearR2Falso();
  const env: Env = {
    DB: d1,
    PDFS: r2,
    AGENT_API_TOKEN: TOKEN_PRUEBA,
    APPROVAL_SECRET: 'secreto-aprobacion',
    ...extra,
  };
  const llamarWorker = (url: string, init?: RequestInit) => worker.fetch(new Request(url, init), env);
  const api = new ApiCloudflare('https://agente.test', TOKEN_PRUEBA, llamarWorker);
  return { api, env, db, objetos, llamarWorker };
}
