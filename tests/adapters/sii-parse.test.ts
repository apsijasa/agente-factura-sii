// tests/adapters/sii-parse.test.ts
import { describe, expect, it } from 'vitest';
import { compararTotales } from '../../src/adapters/sii/parse.js';

describe('compararTotales', () => {
  const esperado = { netoClp: 1320521, ivaClp: 250899, totalClp: 1571420 };

  it('coincide cuando los tres montos son exactamente iguales', () => {
    const r = compararTotales(esperado, { netoClp: 1320521, ivaClp: 250899, totalClp: 1571420 });
    expect(r.coinciden).toBe(true);
    expect(r.diferencias).toHaveLength(0);
  });

  it('reporta cada diferencia exacta y no coincide', () => {
    const r = compararTotales(esperado, { netoClp: 1320521, ivaClp: 250898, totalClp: 1571419 });
    expect(r.coinciden).toBe(false);
    expect(r.diferencias).toEqual([
      'iva: esperado 250899, SII muestra 250898',
      'total: esperado 1571420, SII muestra 1571419',
    ]);
  });
});
