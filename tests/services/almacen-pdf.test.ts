// tests/services/almacen-pdf.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AlmacenPdfLocal, AlmacenPdfSupabase, PREFIJO_SUPABASE } from '../../src/services/almacen-pdf.js';

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');

describe('AlmacenPdfLocal', () => {
  it('guarda el PDF en cliente/<carpeta>/<AAAA>/<MM>/ y lo relee igual', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'clientes-'));
    const almacen = new AlmacenPdfLocal(raiz);
    const ruta = await almacen.guardarFactura('NCA', '2026-07-24', '35', PDF);
    expect(ruta).toContain(join('NCA', '2026', '07', 'Factura_35_NCA_2026-07.pdf'));
    expect((await almacen.obtener(ruta)).equals(PDF)).toBe(true);
  });

  it('rutaPrevista muestra la ruta con folio PENDIENTE', () => {
    const raiz = mkdtempSync(join(tmpdir(), 'clientes-'));
    const almacen = new AlmacenPdfLocal(raiz);
    expect(almacen.rutaPrevista('NCA', '2026-07-24')).toContain('Factura_PENDIENTE_NCA_2026-07.pdf');
  });
});

function supabaseFalso() {
  const upload = vi.fn(async () => ({ error: null as { message: string } | null }));
  const download = vi.fn(async () => ({
    data: new Blob([PDF]),
    error: null as { message: string } | null,
  }));
  const from = vi.fn(() => ({ upload, download }));
  return { sb: { storage: { from } } as unknown as SupabaseClient, from, upload, download };
}

describe('AlmacenPdfSupabase', () => {
  it('sube al bucket facturas con clave relativa y devuelve la ruta con prefijo', async () => {
    const { sb, from, upload } = supabaseFalso();
    const almacen = new AlmacenPdfSupabase(sb);
    const ruta = await almacen.guardarFactura('NCA', '2026-07-24', '35', PDF);
    expect(from).toHaveBeenCalledWith('facturas');
    expect(upload).toHaveBeenCalledWith(
      'NCA/2026/07/Factura_35_NCA_2026-07.pdf',
      PDF,
      expect.objectContaining({ contentType: 'application/pdf', upsert: false }),
    );
    expect(ruta).toBe(`${PREFIJO_SUPABASE}NCA/2026/07/Factura_35_NCA_2026-07.pdf`);
  });

  it('obtener descarga la clave sin el prefijo y devuelve el mismo contenido', async () => {
    const { sb, download } = supabaseFalso();
    const almacen = new AlmacenPdfSupabase(sb);
    const datos = await almacen.obtener(`${PREFIJO_SUPABASE}NCA/2026/07/Factura_35_NCA_2026-07.pdf`);
    expect(download).toHaveBeenCalledWith('NCA/2026/07/Factura_35_NCA_2026-07.pdf');
    expect(datos.equals(PDF)).toBe(true);
  });

  it('rechaza subir contenido que no es PDF', async () => {
    const { sb } = supabaseFalso();
    const almacen = new AlmacenPdfSupabase(sb);
    await expect(almacen.guardarFactura('NCA', '2026-07-24', '35', Buffer.from('<html>'))).rejects.toThrow(/PDF/);
  });

  it('propaga el error de subida sin perder el detalle', async () => {
    const { sb, upload } = supabaseFalso();
    upload.mockResolvedValue({ error: { message: 'bucket lleno' } });
    const almacen = new AlmacenPdfSupabase(sb);
    await expect(almacen.guardarFactura('NCA', '2026-07-24', '35', PDF)).rejects.toThrow(/bucket lleno/);
  });
});
