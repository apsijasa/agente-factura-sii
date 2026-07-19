// tests/adapters/reintentos.test.ts
import { describe, expect, it, vi } from 'vitest';
import { conReintentos, EsReintentableError } from '../../src/adapters/graph/reintentos.js';

describe('conReintentos', () => {
  it('devuelve el resultado al primer intento exitoso', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(conReintentos(fn, { intentos: 3, baseMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reintenta hasta 3 veces ante errores reintentables', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new EsReintentableError('timeout'))
      .mockRejectedValueOnce(new EsReintentableError('timeout'))
      .mockResolvedValue('ok');
    await expect(conReintentos(fn, { intentos: 3, baseMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('agota los intentos y propaga el último error', async () => {
    const fn = vi.fn().mockRejectedValue(new EsReintentableError('caído'));
    await expect(conReintentos(fn, { intentos: 3, baseMs: 1 })).rejects.toThrow('caído');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('no reintenta errores no reintentables', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('400 Bad Request'));
    await expect(conReintentos(fn, { intentos: 3, baseMs: 1 })).rejects.toThrow('400');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
