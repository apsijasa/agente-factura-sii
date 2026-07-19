// tests/domain/dinero.test.ts
import { describe, expect, it } from 'vitest';
import { lineaClp, lineaUf, redondearHalfUp, totalesEsperados } from '../../src/domain/dinero.js';

describe('redondearHalfUp', () => {
  it('redondea 0.5 hacia arriba', () => {
    expect(redondearHalfUp('2.5')).toBe(3);
    expect(redondearHalfUp('2.4')).toBe(2);
    expect(redondearHalfUp('1320520.755')).toBe(1320521);
  });
});

describe('lineaClp', () => {
  it('multiplica monto entero por cantidad', () => {
    expect(lineaClp(95000, 2)).toEqual({ precioUnitarioClp: 95000, totalLineaClp: 190000 });
  });
  it('rechaza monto CLP no entero', () => {
    expect(() => lineaClp(95000.5, 1)).toThrow(/entero/);
  });
  it('rechaza cantidad no positiva', () => {
    expect(() => lineaClp(95000, 0)).toThrow(/cantidad/);
  });
});

describe('lineaUf', () => {
  it('convierte UF a CLP redondeando el precio unitario primero', () => {
    // 33.5 UF * 39418.53 = 1.320.520,755 -> 1.320.521
    expect(lineaUf(33.5, 1, 39418.53)).toEqual({ precioUnitarioClp: 1320521, totalLineaClp: 1320521 });
  });
  it('multiplica el unitario ya redondeado por la cantidad', () => {
    // 2.5 UF * 39418.53 = 98.546,325 -> 98.546; * 3 = 295.638
    expect(lineaUf(2.5, 3, 39418.53)).toEqual({ precioUnitarioClp: 98546, totalLineaClp: 295638 });
  });
});

describe('totalesEsperados', () => {
  it('suma líneas y calcula IVA 19% con redondeo half-up', () => {
    // neto 1.320.521 -> IVA 250.898,99 -> 250.899
    expect(totalesEsperados([1320521])).toEqual({ netoClp: 1320521, ivaClp: 250899, totalClp: 1571420 });
  });
  it('rechaza lista vacía', () => {
    expect(() => totalesEsperados([])).toThrow(/líneas/);
  });
});
