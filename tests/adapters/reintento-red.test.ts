// tests/adapters/reintento-red.test.ts
import { describe, expect, it, vi } from 'vitest';
import { conReintentoDeRed, esCorteDeConexion } from '../../src/adapters/sii/reintento-red.js';

const corte = () => new Error('page.goto: net::ERR_CONNECTION_RESET at https://www4.sii.cl/.../mipeSelEmpresa.cgi');
const sinDormir = async (): Promise<void> => undefined;

describe('reintento ante corte de conexión del SII', () => {
  it('reintenta ante net::ERR_CONNECTION_RESET, espera de forma creciente y avisa', async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(corte()).mockRejectedValueOnce(corte()).mockResolvedValueOnce('formulario');
    const esperas: number[] = [];
    const avisos: string[] = [];
    const r = await conReintentoDeRed(fn, { intentos: 3, esperaMs: 5000, dormir: async (ms) => { esperas.push(ms); }, avisar: (m) => avisos.push(m) });
    expect(r).toBe('formulario');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(esperas).toEqual([5000, 10000]);
    expect(avisos).toHaveLength(2);
    expect(avisos[0]).toContain('intento 1 de 3');
  });

  it('cualquier otro error se propaga al primer intento: no es un corte de red', async () => {
    const otro = new Error('El formulario pertenece a otra empresa ("OTRA"), se esperaba "CTA"');
    const fn = vi.fn<() => Promise<void>>().mockRejectedValue(otro);
    await expect(conReintentoDeRed(fn, { intentos: 3, esperaMs: 1, dormir: sinDormir })).rejects.toBe(otro);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(esCorteDeConexion(otro)).toBe(false);
    expect(esCorteDeConexion(new Error('page.goto: Timeout 120000ms exceeded'))).toBe(false);
  });

  it('agotados los intentos lanza el último corte, sin seguir probando', async () => {
    const fn = vi.fn<() => Promise<void>>().mockRejectedValue(corte());
    await expect(conReintentoDeRed(fn, { intentos: 3, esperaMs: 1, dormir: sinDormir })).rejects.toThrow(/ERR_CONNECTION_RESET/);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
