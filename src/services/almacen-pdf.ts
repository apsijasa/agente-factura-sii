// src/services/almacen-pdf.ts
import { readFile } from 'node:fs/promises';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ApiCloudflare } from '../store/api-cloudflare.js';
import { guardarPdf, rutaFactura, sanitizarNombreCarpeta } from './storage.js';

export const PREFIJO_SUPABASE = 'supabase://facturas/';
export const PREFIJO_R2 = 'r2://facturas/';
const BUCKET = 'facturas';

/**
 * Persistencia de los PDFs emitidos, intercambiable entre el disco local
 * (carpeta cliente/) y el bucket privado de Supabase Storage. La ruta que
 * devuelve guardarFactura es la que queda auditada en pdf_path, y obtener()
 * debe poder releerla meses después (retry-email desde otra máquina).
 */
export interface AlmacenPdf {
  rutaPrevista(carpeta: string, fechaEmision: string): string;
  guardarFactura(carpeta: string, fechaEmision: string, folio: string, datos: Buffer): Promise<string>;
  obtener(ruta: string): Promise<Buffer>;
}

function validarPdf(datos: Buffer): void {
  if (datos.length === 0) throw new Error('El PDF descargado está vacío');
  if (!datos.subarray(0, 5).toString('latin1').startsWith('%PDF')) {
    throw new Error('El contenido descargado no es un PDF');
  }
}

function claveRelativa(carpeta: string, fechaEmision: string, folio: string): string {
  const limpia = sanitizarNombreCarpeta(carpeta);
  if (!/^[A-Za-z0-9-]+$/.test(folio)) {
    throw new Error(`folio inválido: "${folio}" (solo se permite [A-Za-z0-9-])`);
  }
  const [anio, mes] = [fechaEmision.slice(0, 4), fechaEmision.slice(5, 7)];
  return `${limpia}/${anio}/${mes}/Factura_${folio}_${limpia}_${anio}-${mes}.pdf`;
}

export class AlmacenPdfLocal implements AlmacenPdf {
  constructor(private readonly raiz: string) {}

  rutaPrevista(carpeta: string, fechaEmision: string): string {
    return rutaFactura(this.raiz, carpeta, fechaEmision, 'PENDIENTE', carpeta);
  }

  async guardarFactura(carpeta: string, fechaEmision: string, folio: string, datos: Buffer): Promise<string> {
    const destino = rutaFactura(this.raiz, carpeta, fechaEmision, folio, carpeta);
    await guardarPdf(destino, datos);
    return destino;
  }

  async obtener(ruta: string): Promise<Buffer> {
    return readFile(ruta);
  }
}

export class AlmacenPdfSupabase implements AlmacenPdf {
  constructor(private readonly sb: SupabaseClient) {}

  rutaPrevista(carpeta: string, fechaEmision: string): string {
    return `${PREFIJO_SUPABASE}${claveRelativa(carpeta, fechaEmision, 'PENDIENTE')}`;
  }

  async guardarFactura(carpeta: string, fechaEmision: string, folio: string, datos: Buffer): Promise<string> {
    validarPdf(datos);
    const clave = claveRelativa(carpeta, fechaEmision, folio);
    // upsert:false — un folio confirmado jamás se sobrescribe.
    const { error } = await this.sb.storage.from(BUCKET).upload(clave, datos, {
      contentType: 'application/pdf',
      upsert: false,
    });
    if (error) throw new Error(`Supabase Storage upload ${clave}: ${error.message}`);
    return `${PREFIJO_SUPABASE}${clave}`;
  }

  async obtener(ruta: string): Promise<Buffer> {
    const clave = ruta.startsWith(PREFIJO_SUPABASE) ? ruta.slice(PREFIJO_SUPABASE.length) : ruta;
    const { data, error } = await this.sb.storage.from(BUCKET).download(clave);
    if (error || !data) throw new Error(`Supabase Storage download ${clave}: ${error?.message ?? 'sin datos'}`);
    return Buffer.from(await data.arrayBuffer());
  }
}

/**
 * PDFs en Cloudflare R2 (vía el Worker). Los PDFs históricos se copiaron con
 * la MISMA clave que tenían en Supabase Storage, así que obtener() acepta
 * también las rutas antiguas `supabase://facturas/...` ya auditadas en pdf_path.
 */
export class AlmacenPdfR2 implements AlmacenPdf {
  constructor(private readonly api: ApiCloudflare) {}

  rutaPrevista(carpeta: string, fechaEmision: string): string {
    return `${PREFIJO_R2}${claveRelativa(carpeta, fechaEmision, 'PENDIENTE')}`;
  }

  async guardarFactura(carpeta: string, fechaEmision: string, folio: string, datos: Buffer): Promise<string> {
    validarPdf(datos);
    const clave = claveRelativa(carpeta, fechaEmision, folio);
    // El Worker rechaza (409) si la clave ya existe: un folio confirmado jamás se sobrescribe.
    await this.api.subirPdf(clave, datos);
    return `${PREFIJO_R2}${clave}`;
  }

  async obtener(ruta: string): Promise<Buffer> {
    const clave = ruta.startsWith(PREFIJO_R2)
      ? ruta.slice(PREFIJO_R2.length)
      : ruta.startsWith(PREFIJO_SUPABASE)
        ? ruta.slice(PREFIJO_SUPABASE.length)
        : ruta;
    return this.api.descargarPdf(clave);
  }
}
