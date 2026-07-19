// tests/config/config.test.ts
import { describe, expect, it } from 'vitest';
import { esquemaConfig } from '../../src/config/config.js';

const configOk = {
  tenantId: 'tenant-guid',
  clientId: 'client-guid',
  buzonPrincipal: 'buzon@empresa.cl',
  driveId: 'D1',
  itemId: 'I1',
  rutaRaizClientes: '/Users/andrespsijas/Documents/Codex/agente factura sii/cliente',
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
