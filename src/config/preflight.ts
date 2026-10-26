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

export interface OpcionesPreflight {
  verificarGraph: boolean;
  leerSecreto?: (cuenta: string) => Promise<string>;
  // Autenticación app-only (client credentials): /me no existe; se verifica el buzón.
  appOnly?: boolean;
  // En modo nube los PDFs van al bucket; la carpeta local cliente/ no aplica.
  verificarRutaClientes?: boolean;
  // La clave del SII es la credencial más importante del sistema: solo se exige
  // a los comandos que van a abrir el portal. Exigirla a `cancel` o `notify`
  // obligaba a repartirla a workflows que jamás la usan.
  verificarSecretoSii?: boolean;
}

export async function preflight(
  config: Config,
  graph: IGraphClient,
  rutEmisor: string,
  opciones: OpcionesPreflight,
): Promise<ResultadoPreflight> {
  const fallas: string[] = [];
  const leerSecreto = opciones.leerSecreto ?? leerSecretoKeychain;

  try {
    await mkdir(join(config.rutaDatos, 'evidence'), { recursive: true });
  } catch (e) {
    fallas.push(`No se pudo crear el directorio de datos ${config.rutaDatos}: ${(e as Error).message}`);
  }
  if (opciones.verificarRutaClientes ?? true) {
    try {
      await access(config.rutaRaizClientes);
    } catch {
      fallas.push(`Ruta raíz de clientes inaccesible: ${config.rutaRaizClientes}`);
    }
  }

  if (opciones.verificarSecretoSii ?? true) {
    try {
      await leerSecreto(rutEmisor);
    } catch (e) {
      fallas.push((e as Error).message);
    }
  }

  if (opciones.verificarGraph) {
    // App-only: /me no existe y /users/<buzon> exigiría User.Read.All; el
    // chequeo del libro de OneDrive (abajo) ya prueba token y permisos.
    if (!opciones.appOnly) {
      try {
        await graph.solicitar('GET', '/me');
      } catch (e) {
        fallas.push(`Graph no autenticado o sin permisos: ${(e as Error).message}`);
      }
    }
    try {
      await graph.solicitar('GET', `/drives/${config.driveId}/items/${config.itemId}`);
    } catch (e) {
      fallas.push(`Libro de OneDrive inaccesible: ${(e as Error).message}`);
    }
  }

  return { ok: fallas.length === 0, fallas };
}
