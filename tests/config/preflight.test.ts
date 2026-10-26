// tests/config/preflight.test.ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IGraphClient } from '../../src/adapters/graph/graph-client.js';
import type { Config } from '../../src/config/config.js';
import { preflight } from '../../src/config/preflight.js';

async function configBase(sobrescribe: Partial<Config> = {}): Promise<Config> {
  const base = await mkdtemp(join(tmpdir(), 'preflight-'));
  return {
    tenantId: 't',
    clientId: 'c',
    buzonPrincipal: 'buzon@empresa.cl',
    driveId: 'D1',
    itemId: 'I1',
    rutaRaizClientes: base,
    rutaDatos: join(base, '.data'),
    timeoutSiiMs: 120000,
    timeoutAprobacionMs: 300000,
    modoPredeterminado: 'simulation',
    emisores: { E1: { tipoVenta: 'Del Giro', tipoCompra: 'Del Giro' } },
    ...sobrescribe,
  };
}

function graphFalso(registro: string[]): IGraphClient {
  return {
    async solicitar<T>(metodo: string, ruta: string): Promise<T> {
      registro.push(`${metodo} ${ruta}`);
      return undefined as T;
    },
  } as IGraphClient;
}

const secretoOk = async (): Promise<string> => 'secreto';
const secretoFalla = async (): Promise<string> => {
  throw new Error('No hay secreto en el llavero para servicio=agente-factura-sii cuenta=12345678-5.');
};

describe('preflight', () => {
  it('pasa con rutas accesibles, secreto presente y sin verificación Graph', async () => {
    const registro: string[] = [];
    const resultado = await preflight(await configBase(), graphFalso(registro), '12345678-5', {
      verificarGraph: false,
      leerSecreto: secretoOk,
    });
    expect(resultado.ok).toBe(true);
    expect(resultado.fallas).toEqual([]);
    expect(registro).toEqual([]);
  });

  it('agrega la falla del llavero sin lanzar', async () => {
    const registro: string[] = [];
    const resultado = await preflight(await configBase(), graphFalso(registro), '12345678-5', {
      verificarGraph: false,
      leerSecreto: secretoFalla,
    });
    expect(resultado.ok).toBe(false);
    expect(resultado.fallas.some((f) => f.includes('llavero'))).toBe(true);
  });

  it('no exige la clave del SII a un comando que no abre el portal', async () => {
    const resultado = await preflight(await configBase(), graphFalso([]), '12345678-5', {
      verificarGraph: false,
      leerSecreto: secretoFalla,
      verificarSecretoSii: false,
    });
    expect(resultado.ok).toBe(true);
    expect(resultado.fallas).toEqual([]);
  });

  it('agrega la falla de ruta raíz de clientes inaccesible', async () => {
    const config = await configBase({ rutaRaizClientes: '/ruta/que/no/existe/preflight' });
    const resultado = await preflight(config, graphFalso([]), '12345678-5', {
      verificarGraph: false,
      leerSecreto: secretoOk,
    });
    expect(resultado.ok).toBe(false);
    expect(resultado.fallas.some((f) => f.includes('Ruta raíz de clientes inaccesible'))).toBe(true);
  });

  it('agrega la falla de mkdir en vez de lanzar cuando rutaDatos no es creable', async () => {
    const base = await mkdtemp(join(tmpdir(), 'preflight-'));
    const archivo = join(base, 'archivo.txt');
    await writeFile(archivo, 'x', 'utf8');
    const config = await configBase({ rutaDatos: join(archivo, 'sub') });
    const resultado = await preflight(config, graphFalso([]), '12345678-5', {
      verificarGraph: false,
      leerSecreto: secretoOk,
    });
    expect(resultado.ok).toBe(false);
    expect(resultado.fallas.some((f) => f.includes('directorio de datos'))).toBe(true);
  });

  it('consulta Graph solo cuando verificarGraph es true', async () => {
    const registro: string[] = [];
    const config = await configBase();
    const resultado = await preflight(config, graphFalso(registro), '12345678-5', {
      verificarGraph: true,
      leerSecreto: secretoOk,
    });
    expect(resultado.ok).toBe(true);
    expect(registro).toEqual(['GET /me', 'GET /drives/D1/items/I1']);
  });

  it('en modo app-only omite /me y solo verifica el libro de OneDrive', async () => {
    const registro: string[] = [];
    const config = await configBase();
    const resultado = await preflight(config, graphFalso(registro), '12345678-5', {
      verificarGraph: true,
      appOnly: true,
      leerSecreto: secretoOk,
    });
    expect(resultado.ok).toBe(true);
    expect(registro).toEqual(['GET /drives/D1/items/I1']);
  });

  it('agrega fallas de Graph cuando las solicitudes fallan', async () => {
    const grafFalla: IGraphClient = {
      async solicitar<T>(): Promise<T> {
        throw new Error('401 sin permisos');
      },
    } as IGraphClient;
    const resultado = await preflight(await configBase(), grafFalla, '12345678-5', {
      verificarGraph: true,
      leerSecreto: secretoOk,
    });
    expect(resultado.ok).toBe(false);
    expect(resultado.fallas.some((f) => f.includes('Graph no autenticado'))).toBe(true);
    expect(resultado.fallas.some((f) => f.includes('Libro de OneDrive inaccesible'))).toBe(true);
  });
});
