// tests/config/config.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { cargarConfig, esquemaConfig } from '../../src/config/config.js';

const configOk = {
  tenantId: 'tenant-guid',
  clientId: 'client-guid',
  buzonPrincipal: 'buzon@empresa.cl',
  driveId: 'D1',
  itemId: 'I1',
  rutaRaizClientes: '/ruta/absoluta/cliente',
  rutaDatos: '.data',
  timeoutSiiMs: 120000,
  timeoutAprobacionMs: 300000,
  modoPredeterminado: 'simulation',
  emisores: {
    E1: { tipoVenta: 'Del Giro', tipoCompra: 'Del Giro' },
  },
};

describe('esquemaConfig', () => {
  it('acepta una configuración completa', () => {
    expect(esquemaConfig.parse(configOk).modoPredeterminado).toBe('simulation');
  });
  it('el modo predeterminado solo puede ser simulation', () => {
    expect(() => esquemaConfig.parse({ ...configOk, modoPredeterminado: 'emit' })).toThrow();
  });
  it('exige tipoVenta y tipoCompra por emisor (sin valores por defecto)', () => {
    expect(() => esquemaConfig.parse({ ...configOk, emisores: { E1: { tipoVenta: 'Del Giro' } } })).toThrow();
    expect(() => esquemaConfig.parse({ ...configOk, emisores: {} })).toThrow(/emisor/i);
  });
});

// `init` grababa la ruta absoluta del repo, así que mover la carpeta rompía
// todos los comandos locales en el preflight sin tocar nada.
describe('cargarConfig y la raíz de clientes', () => {
  afterEach(() => {
    delete process.env.AGENTE_CONFIG_JSON;
  });

  it('sin rutaRaizClientes la deduce de la raíz del proyecto', async () => {
    const sinRuta: Record<string, unknown> = { ...configOk };
    delete sinRuta.rutaRaizClientes;
    process.env.AGENTE_CONFIG_JSON = JSON.stringify(sinRuta);
    const config = await cargarConfig('/proyecto');
    expect(config.rutaRaizClientes).toBe('/proyecto/cliente');
  });

  it('una ruta relativa se resuelve contra la raíz del proyecto', async () => {
    process.env.AGENTE_CONFIG_JSON = JSON.stringify({ ...configOk, rutaRaizClientes: 'cliente' });
    const config = await cargarConfig('/proyecto');
    expect(config.rutaRaizClientes).toBe('/proyecto/cliente');
  });

  it('respeta una ruta absoluta ya configurada', async () => {
    process.env.AGENTE_CONFIG_JSON = JSON.stringify(configOk);
    const config = await cargarConfig('/proyecto');
    expect(config.rutaRaizClientes).toBe('/ruta/absoluta/cliente');
  });
});
