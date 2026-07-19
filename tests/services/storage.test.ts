// tests/services/storage.test.ts
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  guardarPdf,
  rutaFactura,
  sanitizarNombreCarpeta,
} from '../../src/services/storage.js';

const PDF_MINIMO = Buffer.from('%PDF-1.4\n%%EOF\n');

describe('sanitizarNombreCarpeta', () => {
  it('elimina separadores, control y puntos iniciales', () => {
    expect(sanitizarNombreCarpeta('NCA')).toBe('NCA');
    expect(sanitizarNombreCarpeta('../etc')).toBe('etc');
    expect(sanitizarNombreCarpeta('a/b\\c')).toBe('abc');
  });
  it('rechaza nombres que quedan vacíos', () => {
    expect(() => sanitizarNombreCarpeta('../..')).toThrow(/nombre_carpeta/);
  });
});

describe('rutaFactura', () => {
  it('construye cliente/<carpeta>/<AAAA>/<MM>/Factura_<folio>_<cliente>_<AAAA-MM>.pdf', () => {
    const ruta = rutaFactura('/raiz/cliente', 'NCA', '2026-07-05', '12345', 'NCA');
    expect(ruta).toBe('/raiz/cliente/NCA/2026/07/Factura_12345_NCA_2026-07.pdf');
  });
  it('rechaza rutas que escapan de la raíz autorizada', () => {
    expect(() => rutaFactura('/raiz/cliente', '..', '2026-07-05', '1', 'X')).toThrow();
  });
});

describe('guardarPdf', () => {
  it('escribe de forma atómica y verifica cabecera PDF y tamaño', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'storage-'));
    const destino = join(raiz, 'sub', 'Factura_1_X_2026-07.pdf');
    await guardarPdf(destino, PDF_MINIMO);
    expect(readFileSync(destino).toString()).toContain('%PDF');
  });
  it('rechaza contenido que no es PDF o está vacío', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'storage-'));
    await expect(guardarPdf(join(raiz, 'a.pdf'), Buffer.from(''))).rejects.toThrow(/vacío/);
    await expect(guardarPdf(join(raiz, 'b.pdf'), Buffer.from('<html>'))).rejects.toThrow(/PDF/);
  });
});
