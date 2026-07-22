import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TokenCacheContext } from '@azure/msal-node';
import { cifrar, crearCachePluginCifrado, descifrar } from '../../src/adapters/graph/token-cache.js';

const clave = randomBytes(32);

describe('cifrar/descifrar', () => {
  it('recupera el texto original (ida y vuelta)', () => {
    const sobre = cifrar(clave, 'contenido secreto');
    expect(descifrar(clave, sobre)).toBe('contenido secreto');
  });

  it('rechaza claves que no son de 32 bytes', () => {
    expect(() => cifrar(randomBytes(16), 'x')).toThrow(/32 bytes/);
  });

  it('detecta manipulación del sobre (GCM auth tag)', () => {
    const sobre = JSON.parse(cifrar(clave, 'contenido secreto')) as { datos: string };
    const adulterado = JSON.stringify({
      ...JSON.parse(cifrar(clave, 'contenido secreto')),
      datos: Buffer.from('otra cosa').toString('base64'),
    });
    expect(() => descifrar(clave, adulterado)).toThrow();
    expect(sobre.datos).not.toBe('');
  });

  it('rechaza descifrado con otra clave', () => {
    const sobre = cifrar(clave, 'contenido secreto');
    expect(() => descifrar(randomBytes(32), sobre)).toThrow();
  });
});

describe('crearCachePluginCifrado', () => {
  function contextoFalso(contenido: string, cambiado: boolean) {
    const deserialize = vi.fn();
    return {
      contexto: {
        cacheHasChanged: cambiado,
        tokenCache: { serialize: () => contenido, deserialize },
      } as unknown as TokenCacheContext,
      deserialize,
    };
  }

  it('persiste cifrado y lo restaura en el siguiente acceso', async () => {
    const ruta = join(mkdtempSync(join(tmpdir(), 'msal-')), 'cache.enc');
    const plugin = crearCachePluginCifrado(ruta, async () => clave);

    const escritura = contextoFalso('TOKENS-SERIALIZADOS', true);
    await plugin.afterCacheAccess(escritura.contexto);

    const lectura = contextoFalso('', false);
    await plugin.beforeCacheAccess(lectura.contexto);
    expect(lectura.deserialize).toHaveBeenCalledWith('TOKENS-SERIALIZADOS');
  });

  it('no escribe si el cache no cambió y no falla sin archivo previo', async () => {
    const ruta = join(mkdtempSync(join(tmpdir(), 'msal-')), 'cache.enc');
    const plugin = crearCachePluginCifrado(ruta, async () => clave);

    const lectura = contextoFalso('', false);
    await expect(plugin.beforeCacheAccess(lectura.contexto)).resolves.toBeUndefined();
    expect(lectura.deserialize).not.toHaveBeenCalled();

    await plugin.afterCacheAccess(lectura.contexto);
    await plugin.beforeCacheAccess(lectura.contexto);
    expect(lectura.deserialize).not.toHaveBeenCalled();
  });
});
