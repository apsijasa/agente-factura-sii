// tests/services/correo.test.ts
import { describe, expect, it, vi } from 'vitest';
import { MailService } from '../../src/services/correo.js';
import type { IGraphClient } from '../../src/adapters/graph/graph-client.js';

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');

describe('MailService.enviarFactura', () => {
  it('envía por Graph desde el alias con destinatarios, copia y adjunto', async () => {
    const solicitar = vi.fn().mockResolvedValue(undefined);
    const graph = { solicitar } as unknown as IGraphClient;
    const servicio = new MailService(graph, 'buzon@empresa.cl');

    await servicio.enviarFactura({
      remitente: 'facturas@empresa.cl',
      destinatarios: ['pagos@cliente.cl', 'finanzas@cliente.cl'],
      copia: ['copia@empresa.cl'],
      asunto: 'Factura 12345 — julio 2026',
      cuerpo: 'Adjuntamos la factura del período.',
      nombreAdjunto: 'Factura_12345_NCA_2026-07.pdf',
      pdf: PDF,
    });

    expect(solicitar).toHaveBeenCalledTimes(1);
    const [metodo, ruta, cuerpo] = solicitar.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(metodo).toBe('POST');
    expect(ruta).toBe('/users/buzon@empresa.cl/sendMail');
    const mensaje = (cuerpo as { message: Record<string, unknown> }).message;
    expect(mensaje.from).toEqual({ emailAddress: { address: 'facturas@empresa.cl' } });
    expect(mensaje.toRecipients).toEqual([
      { emailAddress: { address: 'pagos@cliente.cl' } },
      { emailAddress: { address: 'finanzas@cliente.cl' } },
    ]);
    expect(mensaje.ccRecipients).toEqual([{ emailAddress: { address: 'copia@empresa.cl' } }]);
    const adjuntos = mensaje.attachments as { name: string; contentBytes: string }[];
    expect(adjuntos[0]?.name).toBe('Factura_12345_NCA_2026-07.pdf');
    expect(Buffer.from(adjuntos[0]!.contentBytes, 'base64').toString()).toContain('%PDF');
    expect((cuerpo as { saveToSentItems: boolean }).saveToSentItems).toBe(true);
  });

  it('rechaza un adjunto que supera el tamaño máximo permitido', async () => {
    const graph = { solicitar: vi.fn() } as unknown as IGraphClient;
    const servicio = new MailService(graph, 'buzon@empresa.cl');
    const grande = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(3 * 1024 * 1024, 0x20)]);
    await expect(
      servicio.enviarFactura({
        remitente: 'f@e.cl', destinatarios: ['a@b.cl'], copia: [],
        asunto: 'x', cuerpo: 'x', nombreAdjunto: 'grande.pdf', pdf: grande,
      }),
    ).rejects.toThrow(/adjunto/i);
  });

  it('rechaza adjuntar contenido que no es PDF', async () => {
    const graph = { solicitar: vi.fn() } as unknown as IGraphClient;
    const servicio = new MailService(graph, 'buzon@empresa.cl');
    await expect(
      servicio.enviarFactura({
        remitente: 'f@e.cl', destinatarios: ['a@b.cl'], copia: [],
        asunto: 'x', cuerpo: 'x', nombreAdjunto: 'x.pdf', pdf: Buffer.from('<html>'),
      }),
    ).rejects.toThrow(/PDF/);
  });
});
