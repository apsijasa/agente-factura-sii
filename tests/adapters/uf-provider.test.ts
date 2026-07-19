// tests/adapters/uf-provider.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseMontoChileno,
  parseUfHtml,
  urlUfOficial,
  validarValorUf,
} from '../../src/adapters/uf/uf-provider.js';

const html = readFileSync(fileURLToPath(new URL('../fixtures/uf2026.html', import.meta.url)), 'utf8');

describe('parseMontoChileno', () => {
  it('convierte formato chileno a número', () => {
    expect(parseMontoChileno('39.418,53')).toBe(39418.53);
    expect(parseMontoChileno('1.234.567')).toBe(1234567);
  });
  it('rechaza texto no numérico', () => {
    expect(() => parseMontoChileno('n/d')).toThrow(/monto/i);
  });
});

describe('urlUfOficial', () => {
  it('apunta al año de la fecha de emisión', () => {
    expect(urlUfOficial('2026-07-05')).toBe('https://www.sii.cl/valores_y_fechas/uf/uf2026.htm');
  });
});

describe('parseUfHtml', () => {
  it('extrae el valor exacto del día y mes solicitados', () => {
    expect(parseUfHtml(html, '2026-07-05')).toBe(39418.53);
    expect(parseUfHtml(html, '2026-02-01')).toBe(39150.2);
  });
  it('devuelve null si la fecha no existe en la tabla', () => {
    expect(parseUfHtml(html, '2026-08-31')).toBeNull();
    expect(parseUfHtml(html, '2026-07-09')).toBeNull();
  });
});

describe('validarValorUf', () => {
  it('acepta valores dentro del rango razonable', () => {
    expect(() => validarValorUf(39418.53)).not.toThrow();
  });
  it('bloquea valores fuera de rango', () => {
    expect(() => validarValorUf(500)).toThrow(/rango/);
    expect(() => validarValorUf(900000)).toThrow(/rango/);
  });
});
