// tests/domain/rut.test.ts
import { describe, expect, it } from 'vitest';
import { calcularDv, esRutValido, normalizarRut, ocultarRut } from '../../src/domain/rut.js';

describe('normalizarRut', () => {
  it('limpia puntos y espacios y fuerza mayúscula', () => {
    expect(normalizarRut('12.345.678-5')).toBe('12345678-5');
    expect(normalizarRut(' 11111111-1 ')).toBe('11111111-1');
    expect(normalizarRut('9.999.999-k')).toBe('9999999-K');
  });
  it('devuelve null ante formato inválido', () => {
    expect(normalizarRut('')).toBeNull();
    expect(normalizarRut('abc')).toBeNull();
    expect(normalizarRut('12345678')).toBeNull();
  });
});

describe('calcularDv', () => {
  it('calcula dígito verificador módulo 11', () => {
    expect(calcularDv('12345678')).toBe('5');
    expect(calcularDv('11111111')).toBe('1');
  });
});

describe('esRutValido', () => {
  it('acepta RUT con DV correcto', () => {
    expect(esRutValido('12.345.678-5')).toBe(true);
  });
  it('rechaza DV incorrecto', () => {
    expect(esRutValido('12.345.678-9')).toBe(false);
  });
});

describe('ocultarRut', () => {
  it('enmascara el cuerpo dejando primeros 2 dígitos y DV', () => {
    expect(ocultarRut('12345678-5')).toBe('12******-5');
  });
});
