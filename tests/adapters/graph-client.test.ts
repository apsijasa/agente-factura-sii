// tests/adapters/graph-client.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphClient } from '../../src/adapters/graph/graph-client.js';
import { HttpError } from '../../src/adapters/graph/reintentos.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GraphClient', () => {
  it('devuelve el JSON parseado y envía el encabezado Authorization', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ displayName: 'Ana' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const cliente = new GraphClient(async () => 'token-abc');

    await expect(cliente.solicitar('GET', '/me')).resolves.toEqual({ displayName: 'Ana' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.microsoft.com/v1.0/me');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer token-abc');
  });

  it('devuelve undefined ante 204 No Content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const cliente = new GraphClient(async () => 'token-abc');
    await expect(cliente.solicitar('DELETE', '/me/messages/x')).resolves.toBeUndefined();
  });

  it('lanza HttpError sin filtrar el token ante un error no reintentable', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('solicitud malformada', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const cliente = new GraphClient(async () => 'token-secreto-123');

    const error: unknown = await cliente.solicitar('GET', '/me').then(
      () => {
        throw new Error('no debió resolver');
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(400);
    expect((error as HttpError).message).toContain('HTTP 400');
    expect((error as HttpError).message).not.toContain('token-secreto-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reintenta ante 500 y vuelve a solicitar el token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('error interno', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const obtenerToken = vi.fn().mockResolvedValue('token-abc');
    const cliente = new GraphClient(obtenerToken);

    await expect(cliente.solicitar('GET', '/me')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(obtenerToken).toHaveBeenCalledTimes(2);
  });
});

describe('GraphClient respuestas sin cuerpo', () => {
  it('trata 202 Accepted (sendMail) como éxito sin parsear JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('', { status: 202 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const cliente = new GraphClient(async () => 'token-abc');
    await expect(cliente.solicitar('POST', '/users/x/sendMail', { message: {} })).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });
});
