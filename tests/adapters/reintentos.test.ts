// tests/adapters/reintentos.test.ts
import { describe, expect, it, vi } from 'vitest';
import { conReintentos, EsReintentableError, HttpError } from '../../src/adapters/graph/reintentos.js';

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

  it('reintenta HttpError con status 503', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpError(503, 'HTTP 503 en GET /x: servicio no disponible'))
      .mockResolvedValue('ok');
    await expect(conReintentos(fn, { intentos: 3, baseMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('reintenta HttpError con status 429', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpError(429, 'HTTP 429 en GET /x: demasiadas solicitudes'))
      .mockResolvedValue('ok');
    await expect(conReintentos(fn, { intentos: 3, baseMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('no reintenta HttpError 400 aunque el mensaje contenga "429"', async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new HttpError(400, 'HTTP 400 en GET /x: el cuerpo menciona límite 429'));
    await expect(conReintentos(fn, { intentos: 3, baseMs: 1 })).rejects.toThrow('HTTP 400');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reintenta errores de red por timeout o aborto', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
      .mockResolvedValue('ok');
    await expect(conReintentos(fn, { intentos: 3, baseMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rechaza con error claro si intentos <= 0', async () => {
    const fn = vi.fn();
    await expect(conReintentos(fn, { intentos: 0, baseMs: 1 })).rejects.toThrow(/intentos/i);
    expect(fn).not.toHaveBeenCalled();
  });
});
