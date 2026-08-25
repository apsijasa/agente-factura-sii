// tests/adapters/folio.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extraerFolio } from '../../src/adapters/sii/parse.js';

const textoPlano = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&deg;/g, '°').replace(/\s+/g, ' ');

describe('extraerFolio', () => {
  it('lee el folio de la confirmación real del SII ("FACTURA ELECTRÓNICA N° 42")', () => {
    // Evidencia capturada el 2026-08-25 en la emisión de CLI-029 (folio 42):
    // esta página NO contiene la palabra "folio" ni un parámetro FOLIO=.
    const html = readFileSync(join(__dirname, '../fixtures/confirmacion-emision-folio42.html'), 'utf8');
    // Los dos patrones antiguos no calzan aquí: por eso la emisión de CLI-029
    // quedó en REQUIERE_REVISION pese a estar emitida.
    expect(/folio\s*n?[°º]?\s*(\d+)/i.test(textoPlano(html))).toBe(false);
    expect(/FOLIO\s*=\s*(\d+)/i.test(html)).toBe(false);
    expect(extraerFolio(textoPlano(html), html)).toBe('42');
  });

  it('sigue leyendo el rótulo histórico "Folio N° 36"', () => {
    expect(extraerFolio('Documento emitido. Folio N° 36')).toBe('36');
  });

  it('sigue leyendo el folio desde la URL del DTE', () => {
    expect(extraerFolio('', '<a href="mipeShowDte.cgi?RUT=1&FOLIO=36">Ver</a>')).toBe('36');
  });

  it('devuelve null cuando no hay folio', () => {
    expect(extraerFolio('Error inesperado del portal', '<html></html>')).toBeNull();
  });
});
