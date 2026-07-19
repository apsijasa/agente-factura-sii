// src/adapters/uf/uf-provider.ts
import * as cheerio from 'cheerio';
import { conReintentos, HttpError, HTTP_TIMEOUT_MS } from '../graph/reintentos.js';

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const UF_MIN = 10000;
const UF_MAX = 200000;

export interface ValorUfRegistrado {
  valor: number;
  fecha: string;
  url: string;
  consultadoEn: string;
}

export function parseMontoChileno(texto: string): number {
  const limpio = texto.trim();
  if (!/^\d{1,3}(\.\d{3})*(,\d+)?$/.test(limpio)) {
    throw new Error(`Monto chileno inválido: "${texto}"`);
  }
  return Number(limpio.replace(/\./g, '').replace(',', '.'));
}

export function urlUfOficial(fechaIso: string): string {
  return `https://www.sii.cl/valores_y_fechas/uf/uf${fechaIso.slice(0, 4)}.htm`;
}

export function parseUfHtml(html: string, fechaIso: string): number | null {
  const mes = Number(fechaIso.slice(5, 7));
  const dia = Number(fechaIso.slice(8, 10));
  const $ = cheerio.load(html);
  let valor: number | null = null;

  $('table').each((_, tabla) => {
    const filas = $(tabla).find('tr');
    const encabezados = filas
      .first()
      .find('th,td')
      .map((_, el) => $(el).text().trim())
      .get();
    const col = encabezados.findIndex((h) => h.startsWith(MESES[mes - 1] as string));
    if (col === -1) return;
    filas.slice(1).each((_, tr) => {
      const celdas = $(tr)
        .find('th,td')
        .map((_, el) => $(el).text().trim())
        .get();
      if (Number(celdas[0]) === dia && celdas[col]) {
        const encontrado = parseMontoChileno(celdas[col] as string);
        if (valor !== null && valor !== encontrado) {
          throw new Error(
            `Valor UF ambiguo para ${fechaIso}: se encontraron ${valor} y ${encontrado} en la tabla`,
          );
        }
        valor = encontrado;
      }
    });
  });
  return valor;
}

export function validarValorUf(valor: number): void {
  if (!(valor >= UF_MIN && valor <= UF_MAX)) {
    throw new Error(`Valor UF fuera de rango razonable [${UF_MIN}, ${UF_MAX}]: ${valor}`);
  }
}

export class UfProvider {
  constructor(private readonly descargar: (url: string) => Promise<string> = descargarHtml) {}

  async obtenerValorUf(fechaIso: string): Promise<ValorUfRegistrado> {
    const url = urlUfOficial(fechaIso);
    const html = await conReintentos(() => this.descargar(url), { intentos: 3, baseMs: 500 });
    const valor = parseUfHtml(html, fechaIso);
    if (valor === null) {
      throw new Error(`No existe valor UF publicado para ${fechaIso} en ${url}; factura bloqueada`);
    }
    validarValorUf(valor);
    return { valor, fecha: fechaIso, url, consultadoEn: new Date().toISOString() };
  }
}

async function descargarHtml(url: string): Promise<string> {
  const respuesta = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!respuesta.ok) {
    throw new HttpError(respuesta.status, `HTTP ${respuesta.status} al consultar ${url}`);
  }
  return respuesta.text();
}
