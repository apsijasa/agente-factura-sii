// tests/services/correo.test.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MailService } from '../../src/services/correo.js';
import type { IGraphClient } from '../../src/adapters/graph/graph-client.js';

function crearPdf(): string {
  const dir = mkdtempSync(join(tmpdir(), 'correo-'));
  const ruta = join(dir, 'Factura_12345_NCA_2026-07.pdf');
  writeFileSync(ruta, '%PDF-1.4\n%%EOF\n');
  return ruta;
}

describe('MailService.enviarFactura', () => {
  it('envía por Graph desde el alias con destinatarios, copia y adjunto', async () => {
    const solicitar = vi.fn().mockResolvedValue(undefined);
    const graph = { solicitar } as unknown as IGraphClient;
    const servicio = new MailService(graph, 'buzon@empresa.cl');
    const rutaPdf = crearPdf();

    await servicio.enviarFactura({
      remitente: 'facturas@empresa.cl',
      destinatarios: ['pagos@cliente.cl', 'finanzas@cliente.cl'],
      copia: ['copia@empresa.cl'],
      asunto: 'Factura 12345 — julio 2026',
      cuerpo: 'Adjuntamos la factura del período.',
      rutaPdf,
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

  it('rechaza adjuntar un archivo que no es PDF', async () => {
    const graph = { solicitar: vi.fn() } as unknown as IGraphClient;
    const servicio = new MailService(graph, 'buzon@empresa.cl');
    const dir = mkdtempSync(join(tmpdir(), 'correo-'));
    const rutaNoPdf = join(dir, 'x.pdf');
    writeFileSync(rutaNoPdf, '<html>');
    await expect(
      servicio.enviarFactura({
        remitente: 'f@e.cl', destinatarios: ['a@b.cl'], copia: [],
        asunto: 'x', cuerpo: 'x', rutaPdf: rutaNoPdf,
      }),
    ).rejects.toThrow(/PDF/);
  });
});
