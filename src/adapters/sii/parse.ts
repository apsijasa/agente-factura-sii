// src/adapters/sii/parse.ts
export { parseMontoChileno } from '../uf/uf-provider.js';

export interface TotalesSii {
  netoClp: number;
  ivaClp: number;
  totalClp: number;
}

export function compararTotales(
  esperado: TotalesSii,
  mostrado: TotalesSii,
): { coinciden: boolean; diferencias: string[] } {
  const diferencias: string[] = [];
  const campos: [string, number, number][] = [
    ['neto', esperado.netoClp, mostrado.netoClp],
    ['iva', esperado.ivaClp, mostrado.ivaClp],
    ['total', esperado.totalClp, mostrado.totalClp],
  ];
  for (const [nombre, esp, real] of campos) {
    if (esp !== real) diferencias.push(`${nombre}: esperado ${esp}, SII muestra ${real}`);
  }
  return { coinciden: diferencias.length === 0, diferencias };
}

/**
 * Folio en la confirmación de emisión del SII.
 *
 * El portal no usa la palabra "folio" en esa página: rotula el documento como
 * "FACTURA ELECTRÓNICA N° 42" (evidencia real 2026-08-25, folio 42). El patrón
 * histórico ("Folio N° 36") y el de la URL (`&FOLIO=36`) siguen cubiertos
 * porque otras confirmaciones sí los traen; se prueban en ese orden y el
 * primero que calce gana.
 */
const PATRONES_FOLIO: readonly RegExp[] = [
  /folio\s*n?[°º]?\s*(\d+)/i,
  /factura\s+electr[óo]nica\s*n?[°º]?\s*(\d+)/i,
  /FOLIO\s*=\s*(\d+)/i,
];

export function extraerFolio(texto: string, html = ''): string | null {
  for (const patron of PATRONES_FOLIO) {
    const m = patron.exec(texto) ?? patron.exec(html);
    if (m) return m[1] as string;
  }
  return null;
}
