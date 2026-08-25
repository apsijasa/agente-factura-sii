// src/adapters/sii/vigilante-folio.ts
import { extraerFolio } from './parse.js';

/**
 * Retiene el PRIMER folio visto después del clic de emisión.
 *
 * El portal muestra la confirmación en una ventana que puede cerrarse sola en
 * menos de lo que dura un sondeo: en el lote del 2026-08-25, 5 de 11 facturas
 * quedaron sin folio (42, 46, 48, 50 y 52) pese a haberse emitido de verdad.
 * Por eso la captura es por EVENTO de navegación y no por muestreo periódico.
 *
 * La vigilancia solo cuenta mientras está armada — entre `armar()` y
 * `desarmar()`, es decir, dentro de una única emisión. Así el folio de una
 * factura anterior, cuya ventana puede seguir abierta en la misma sesión de
 * navegador, jamás puede colarse como folio de la siguiente.
 */
export class VigilanteFolio {
  private armado = false;
  private folio: string | null = null;

  /** Inicia la vigilancia de una emisión y descarta cualquier folio previo. */
  armar(): void {
    this.armado = true;
    this.folio = null;
  }

  /**
   * Cierra la vigilancia y suelta el folio retenido: fuera de una emisión el
   * vigilante no guarda nada, para que ningún camino pueda leer como "folio
   * de esta factura" el de la anterior. Quien necesite el valor debe haberlo
   * tomado antes de desarmar.
   */
  desarmar(): void {
    this.armado = false;
    this.folio = null;
  }

  get capturado(): string | null {
    return this.folio;
  }

  /**
   * Ofrece a la vigilancia lo que se ve en una página. Devuelve el folio
   * retenido (el primero visto gana; lo siguiente ya no lo cambia).
   */
  observar(fuente: { url?: string; texto?: string; html?: string }): string | null {
    if (!this.armado || this.folio) return this.folio;
    const visto =
      extraerFolio(fuente.url ?? '') ?? extraerFolio(fuente.texto ?? '', fuente.html ?? '');
    if (visto) this.folio = visto;
    return this.folio;
  }
}
