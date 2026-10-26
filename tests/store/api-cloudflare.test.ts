// tests/store/api-cloudflare.test.ts
// Timeout y reintento acotado del cliente del Worker. Lo que se fija aquí es
// la política: fallas de red, timeouts y 5xx se reintentan; un 4xx (el 409 del
// CAS, YA_EXISTE, FACTURA_DUPLICADA) es una respuesta y se entrega tal cual.
import { describe, expect, it, vi } from 'vitest';
import { ApiCloudflare } from '../../src/store/api-cloudflare.js';

const rapida = { timeoutMs: 50, intentos: 3, baseMs: 1 };
const ok = () => new Response(JSON.stringify({ results: [], changes: 1 }), { status: 200 });

describe('ApiCloudflare: timeout y reintento', () => {
  it('reintenta ante fallo de red y ante 5xx, y entrega el resultado del intento que pasó', async () => {
    const fetchImpl = vi
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('{"error":"D1 no disponible"}', { status: 503 }))
      .mockResolvedValueOnce(ok());
    const api = new ApiCloudflare('https://agente.test', 't', fetchImpl, rapida);
    await expect(api.query('UPDATE invoice_runs SET folio_sii = ? WHERE factura_id = ?', ['70', 'X'])).resolves.toEqual({
      results: [],
      changes: 1,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('no reintenta un 4xx: el 409 del compare-and-swap es una respuesta, no una falla', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"TRANSICION_CONCURRENTE"}', { status: 409 }));
    const api = new ApiCloudflare('https://agente.test', 't', fetchImpl, rapida);
    await expect(api.registrarTransicion('X', 'APROBADA', 'EMITIENDO', 'inicio')).rejects.toMatchObject({
      estado: 409,
      codigo: 'TRANSICION_CONCURRENTE',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('un fetch colgado se corta por timeout y se reintenta; agotados los intentos, lanza', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, rechazar) => {
          init?.signal?.addEventListener('abort', () => rechazar(init.signal?.reason as Error));
        }),
    );
    const api = new ApiCloudflare('https://agente.test', 't', fetchImpl, rapida);
    await expect(api.descargarPdf('NCA/2026/07/Factura_35.pdf')).rejects.toThrow(/timeout|abort/i);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
