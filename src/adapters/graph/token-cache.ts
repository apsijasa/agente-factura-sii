// src/adapters/graph/token-cache.ts
// Cache persistente del token MSAL, cifrado con AES-256-GCM. La llave vive en
// el llavero de macOS; el archivo cifrado queda en .data (fuera de Git).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ICachePlugin, TokenCacheContext } from '@azure/msal-node';

interface SobreCifrado {
  iv: string;
  tag: string;
  datos: string;
}

export function cifrar(clave: Buffer, textoPlano: string): string {
  if (clave.length !== 32) throw new Error('La clave de cifrado debe tener 32 bytes');
  const iv = randomBytes(12);
  const cifrador = createCipheriv('aes-256-gcm', clave, iv);
  const datos = Buffer.concat([cifrador.update(textoPlano, 'utf8'), cifrador.final()]);
  const sobre: SobreCifrado = {
    iv: iv.toString('base64'),
    tag: cifrador.getAuthTag().toString('base64'),
    datos: datos.toString('base64'),
  };
  return JSON.stringify(sobre);
}

export function descifrar(clave: Buffer, sobreSerializado: string): string {
  const sobre = JSON.parse(sobreSerializado) as SobreCifrado;
  const descifrador = createDecipheriv('aes-256-gcm', clave, Buffer.from(sobre.iv, 'base64'));
  descifrador.setAuthTag(Buffer.from(sobre.tag, 'base64'));
  return Buffer.concat([
    descifrador.update(Buffer.from(sobre.datos, 'base64')),
    descifrador.final(),
  ]).toString('utf8');
}

export function crearCachePluginCifrado(
  rutaArchivo: string,
  obtenerClave: () => Promise<Buffer>,
): ICachePlugin {
  return {
    async beforeCacheAccess(contexto: TokenCacheContext): Promise<void> {
      try {
        const sobre = await readFile(rutaArchivo, 'utf8');
        const clave = await obtenerClave();
        contexto.tokenCache.deserialize(descifrar(clave, sobre));
      } catch {
        // Sin cache previo, ilegible o manipulado: se parte de cero y el
        // flujo pedirá autenticación por código de dispositivo.
      }
    },
    async afterCacheAccess(contexto: TokenCacheContext): Promise<void> {
      if (!contexto.cacheHasChanged) return;
      const clave = await obtenerClave();
      await mkdir(dirname(rutaArchivo), { recursive: true });
      await writeFile(rutaArchivo, cifrar(clave, contexto.tokenCache.serialize()), { mode: 0o600 });
    },
  };
}
