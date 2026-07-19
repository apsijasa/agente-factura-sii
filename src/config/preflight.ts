// src/config/preflight.ts
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { IGraphClient } from '../adapters/graph/graph-client.js';
import { leerSecretoKeychain } from './keychain.js';

export interface ResultadoPreflight {
  ok: boolean;
  fallas: string[];
}

export async function preflight(
  config: Config,
  graph: IGraphClient,
  rutEmisor: string,
  opciones: { verificarGraph: boolean },
): Promise<ResultadoPreflight> {
  const fallas: string[] = [];

  await mkdir(join(config.rutaDatos, 'evidence'), { recursive: true });
  try {
    await access(config.rutaRaizClientes);
  } catch {
    fallas.push(`Ruta raíz de clientes inaccesible: ${config.rutaRaizClientes}`);
  }

  try {
    await leerSecretoKeychain(rutEmisor);
  } catch (e) {
    fallas.push((e as Error).message);
  }

  if (opciones.verificarGraph) {
    try {
      await graph.solicitar('GET', '/me');
    } catch (e) {
      fallas.push(`Graph no autenticado o sin permisos: ${(e as Error).message}`);
    }
    try {
      await graph.solicitar('GET', `/drives/${config.driveId}/items/${config.itemId}`);
    } catch (e) {
      fallas.push(`Libro de OneDrive inaccesible: ${(e as Error).message}`);
    }
  }

  return { ok: fallas.length === 0, fallas };
}
