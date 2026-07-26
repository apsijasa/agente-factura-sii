// tests/services/notificador.test.ts
import { describe, expect, it, vi } from 'vitest';
import { crearNotificador, NotificadorCorreo, NotificadorTelegram, NotificadorWhatsApp } from '../../src/services/notificador.js';
import type { IGraphClient } from '../../src/adapters/graph/graph-client.js';

describe('NotificadorWhatsApp', () => {
  it('envía el mensaje por la Cloud API de Meta al número configurado', async () => {
    const fetchFalso = vi.fn(async () => new Response('{}', { status: 200 }));
    const canal = new NotificadorWhatsApp(
      { token: 'tok', phoneId: '123', para: '56911112222' },
      fetchFalso as unknown as typeof fetch,
    );
    await canal.enviar('hola factura');
    expect(fetchFalso).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFalso.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v20.0/123/messages');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const cuerpo = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(cuerpo).toMatchObject({
      messaging_product: 'whatsapp',
      to: '56911112222',
      type: 'text',
      text: { body: 'hola factura' },
    });
  });

  it('lanza un error claro si Meta responde con fallo', async () => {
    const fetchFalso = vi.fn(async () => new Response('{"error":"token vencido"}', { status: 401 }));
    const canal = new NotificadorWhatsApp(
      { token: 'tok', phoneId: '123', para: '569' },
      fetchFalso as unknown as typeof fetch,
    );
    await expect(canal.enviar('x')).rejects.toThrow(/WhatsApp.*401/);
  });
});

describe('NotificadorTelegram', () => {
  it('envía el mensaje por la Bot API al chat configurado', async () => {
    const fetchFalso = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const canal = new NotificadorTelegram(
      { token: '123:abc', chatId: '55667788' },
      fetchFalso as unknown as typeof fetch,
    );
    await canal.enviar('hola factura');
    const [url, init] = fetchFalso.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    const cuerpo = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(cuerpo).toMatchObject({ chat_id: '55667788', text: 'hola factura' });
  });

  it('el error ante fallo NO incluye la URL (contiene el token del bot)', async () => {
    const fetchFalso = vi.fn(async () => new Response('{"ok":false}', { status: 401 }));
    const canal = new NotificadorTelegram(
      { token: 'token-secreto', chatId: '1' },
      fetchFalso as unknown as typeof fetch,
    );
    await expect(canal.enviar('x')).rejects.toThrow(/Telegram.*401/);
    await expect(canal.enviar('x')).rejects.not.toThrow(/token-secreto/);
  });
});

describe('NotificadorCorreo', () => {
  it('envía el aviso por Graph al buzón principal sin adjunto', async () => {
    const solicitar = vi.fn().mockResolvedValue(undefined);
    const graph = { solicitar } as unknown as IGraphClient;
    const canal = new NotificadorCorreo(graph, 'buzon@empresa.cl');
    await canal.enviar('resumen de la factura');
    const [metodo, ruta, cuerpo] = solicitar.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(metodo).toBe('POST');
    expect(ruta).toBe('/users/buzon@empresa.cl/sendMail');
    const mensaje = (cuerpo as { message: { subject: string; body: { content: string } } }).message;
    expect(mensaje.subject).toMatch(/aprobaci[oó]n/i);
    expect(mensaje.body.content).toContain('resumen de la factura');
  });
});

describe('crearNotificador', () => {
  const graph = { solicitar: vi.fn() } as unknown as IGraphClient;

  it('prefiere Telegram sobre WhatsApp cuando ambos están configurados', () => {
    const canal = crearNotificador(
      {
        TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'c',
        WHATSAPP_TOKEN: 'w', WHATSAPP_PHONE_ID: 'p', WHATSAPP_TO: '569',
      },
      graph,
      'buzon@empresa.cl',
    );
    expect(canal).toBeInstanceOf(NotificadorTelegram);
  });

  it('cae a correo si Telegram está incompleto y no hay WhatsApp', () => {
    const canal = crearNotificador({ TELEGRAM_BOT_TOKEN: 't' }, graph, 'buzon@empresa.cl');
    expect(canal).toBeInstanceOf(NotificadorCorreo);
  });

  it('elige WhatsApp cuando las tres variables están presentes', () => {
    const canal = crearNotificador(
      { WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: 'p', WHATSAPP_TO: '569' },
      graph,
      'buzon@empresa.cl',
    );
    expect(canal).toBeInstanceOf(NotificadorWhatsApp);
  });

  it('cae a correo cuando falta cualquiera de las variables de WhatsApp', () => {
    const canal = crearNotificador({ WHATSAPP_TOKEN: 't' }, graph, 'buzon@empresa.cl');
    expect(canal).toBeInstanceOf(NotificadorCorreo);
  });
});
