// tests/domain/fechas.test.ts
import { describe, expect, it } from 'vitest';
import {
  esVigente,
  estaAtrasada,
  fechaProgramada,
  fechaVencimiento,
  periodoDe,
} from '../../src/domain/fechas.js';

describe('periodoDe', () => {
  it('extrae AAAA-MM de una fecha ISO', () => {
    expect(periodoDe('2026-07-18')).toBe('2026-07');
  });
});

describe('fechaProgramada', () => {
  it('combina período con día de emisión con cero a la izquierda', () => {
    expect(fechaProgramada('2026-07', 5)).toBe('2026-07-05');
    expect(fechaProgramada('2026-07', 28)).toBe('2026-07-28');
  });
  it('rechaza día fuera de 1..28', () => {
    expect(() => fechaProgramada('2026-07', 29)).toThrow(/dia_emision/);
    expect(() => fechaProgramada('2026-07', 0)).toThrow(/dia_emision/);
  });
});

describe('esVigente', () => {
  const cobro = { fecha_inicio: '2026-01-01', fecha_fin: null as string | null };
  it('vigente cuando fecha >= inicio y sin fecha_fin', () => {
    expect(esVigente(cobro, '2026-07-18')).toBe(true);
    expect(esVigente(cobro, '2025-12-31')).toBe(false);
  });
  it('respeta fecha_fin inclusiva', () => {
    const acotado = { fecha_inicio: '2026-01-01', fecha_fin: '2026-06-30' };
    expect(esVigente(acotado, '2026-06-30')).toBe(true);
    expect(esVigente(acotado, '2026-07-01')).toBe(false);
  });
});

describe('estaAtrasada', () => {
  it('detecta fecha programada anterior a hoy', () => {
    expect(estaAtrasada('2026-07-05', '2026-07-18')).toBe(true);
    expect(estaAtrasada('2026-07-18', '2026-07-18')).toBe(false);
  });
});

describe('fechaVencimiento', () => {
  it('CONTADO vence el mismo día', () => {
    expect(fechaVencimiento('2026-07-18', 'CONTADO', 0)).toBe('2026-07-18');
  });
  it('CREDITO suma dias_vencimiento', () => {
    expect(fechaVencimiento('2026-07-18', 'CREDITO', 30)).toBe('2026-08-17');
  });
  it('rechaza CONTADO con días distintos de cero', () => {
    expect(() => fechaVencimiento('2026-07-18', 'CONTADO', 30)).toThrow(/CONTADO/);
  });
});
