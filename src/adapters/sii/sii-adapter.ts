// src/adapters/sii/sii-adapter.ts
import { chromium, type Browser, type Page } from 'playwright';
import { compararTotales, parseMontoChileno, type TotalesSii } from './parse.js';
import { SELECTORES } from './selectores.js';
import type { InvoicePayload } from '../../domain/tipos.js';

export interface ResultadoPreview {
  totales: TotalesSii;
  coinciden: boolean;
  diferencias: string[];
}

export interface ResultadoEmision {
  folio: string;
  pdf: Buffer;
}

/**
 * La emisión fue CONFIRMADA por el SII (hay folio), pero falló la descarga
 * del PDF. Quien lo capture debe persistir el folio y tratar la descarga
 * como reintentable; NUNCA debe tratarse como emisión incierta.
 */
export class EmisionConfirmadaSinPdfError extends Error {
  constructor(
    readonly folio: string,
    detalle: string,
  ) {
    super(`Emisión CONFIRMADA con folio ${folio}, pero falló la descarga del PDF: ${detalle}`);
  }
}

export interface ISiiAdapter {
  abrirYPreparar(payload: InvoicePayload): Promise<void>;
  extraerPreview(payload: InvoicePayload): Promise<ResultadoPreview>;
  emitirUnaVez(): Promise<ResultadoEmision>;
  consultarDocumentosEmitidos(rutReceptor: string, fecha: string): Promise<string | null>;
  cerrar(): Promise<void>;
}

export class SiiAdapterPlaywright implements ISiiAdapter {
  private navegador: Browser | null = null;
  private pagina: Page | null = null;

  constructor(
    private readonly opciones: {
      dirEvidencia: string; // .data/evidence
      timeoutMs: number;
    },
  ) {}

  private async paginaActiva(): Promise<Page> {
    if (this.pagina) {
      // No se relanza en silencio: una sesión nueva perdería el estado del
      // formulario y la autenticación del operador sin que nadie lo note.
      if (this.pagina.isClosed() || !this.navegador?.isConnected()) {
        throw new Error('el navegador del SII fue cerrado; reinicie el comando');
      }
      return this.pagina;
    }
    // Navegador VISIBLE: el operador humano completa credencial/certificado/MFA.
    // El agente NUNCA evade CAPTCHA ni MFA (diseño §3.5).
    this.navegador = await chromium.launch({ headless: false });
    const contexto = await this.navegador.newContext();
    this.pagina = await contexto.newPage();
    this.pagina.setDefaultTimeout(this.opciones.timeoutMs);
    return this.pagina;
  }

  async abrirYPreparar(payload: InvoicePayload): Promise<void> {
    const pagina = await this.paginaActiva();
    await pagina.goto(SELECTORES.urlEmisionFactura);
    // Espera a que el operador esté autenticado (heurística: aparece el formulario).
    await pagina.getByLabel(SELECTORES.campoRutReceptor.etiqueta).waitFor({ timeout: this.opciones.timeoutMs });

    await pagina.getByLabel(SELECTORES.campoRutReceptor.etiqueta).fill(payload.rut_cliente);
    await pagina.getByLabel(SELECTORES.tipoVenta.etiqueta).selectOption({ label: payload.tipo_venta });
    await pagina.getByLabel(SELECTORES.tipoCompra.etiqueta).selectOption({ label: payload.tipo_compra });

    for (const [i, linea] of payload.lineas.entries()) {
      if (i > 0) await pagina.getByRole('button', { name: SELECTORES.botonAgregarLinea.nombre }).click();
      const fila = pagina.locator('tr.linea-detalle').nth(i);
      await fila.getByRole('textbox', { name: SELECTORES.lineaDescripcion(i).nombre }).fill(linea.descripcion);
      await fila.getByRole('textbox', { name: SELECTORES.lineaCantidad(i).nombre }).fill(String(linea.cantidad));
      await fila.getByRole('textbox', { name: SELECTORES.lineaPrecio(i).nombre }).fill(String(linea.precio_unitario_clp));
    }
    await pagina.getByRole('button', { name: SELECTORES.botonVistaPrevia.nombre }).click();
  }

  async extraerPreview(payload: InvoicePayload): Promise<ResultadoPreview> {
    const pagina = await this.paginaActiva();
    const leerMonto = async (patron: RegExp): Promise<number> => {
      const fila = pagina.getByText(patron).locator('xpath=ancestor::tr[1]');
      const texto = (await fila.innerText()).replace(/\s+/g, ' ');
      const m = /([\d.]+(?:,\d+)?)\s*$/.exec(texto.trim());
      if (!m) throw new Error(`No se pudo leer el monto para ${patron}`);
      return parseMontoChileno(m[1] as string);
    };
    const totales: TotalesSii = {
      netoClp: await leerMonto(SELECTORES.previewNeto.texto),
      ivaClp: await leerMonto(SELECTORES.previewIva.texto),
      totalClp: await leerMonto(SELECTORES.previewTotal.texto),
    };
    await pagina.screenshot({
      path: `${this.opciones.dirEvidencia}/preview-${payload.factura_id.replaceAll(':', '_')}.png`,
      fullPage: true,
    });
    const comparacion = compararTotales(
      { netoClp: payload.neto_clp, ivaClp: payload.iva_clp, totalClp: payload.total_clp },
      totales,
    );
    return { totales, ...comparacion };
  }

  async emitirUnaVez(): Promise<ResultadoEmision> {
    const pagina = await this.paginaActiva();
    // ÚNICA acción de emisión. Sin reintentos automáticos (diseño §10).
    await pagina.getByRole('button', { name: SELECTORES.botonEmitir.nombre }).click();

    // Tras el clic de emisión NO se sabe si el SII procesó la solicitud:
    // cualquier fallo antes de confirmar el folio se etiqueta como incierto.
    let folio: string;
    try {
      await pagina.waitForLoadState('networkidle');
      const texto = await pagina.innerText('body');
      const m = SELECTORES.folioEnConfirmacion.exec(texto);
      if (!m) throw new Error('RESPUESTA_INCIERTA: no se encontró folio en la confirmación');
      folio = m[1] as string;
    } catch (error) {
      const mensaje = (error as Error).message;
      if (mensaje.startsWith('RESPUESTA_INCIERTA:')) throw error;
      throw new Error(`RESPUESTA_INCIERTA: fallo tras el clic de emisión: ${mensaje}`);
    }

    // Con folio confirmado, un fallo en la descarga del PDF NO es incierto:
    // la emisión existe y el folio debe sobrevivir para persistirse.
    try {
      const [descarga] = await Promise.all([
        pagina.waitForEvent('download'),
        pagina.getByRole('link', { name: SELECTORES.enlacePdf.nombre }).first().click(),
      ]);
      const rutaTmp = await descarga.path();
      const { readFile } = await import('node:fs/promises');
      return { folio, pdf: await readFile(rutaTmp) };
    } catch (error) {
      throw new EmisionConfirmadaSinPdfError(folio, (error as Error).message);
    }
  }

  async consultarDocumentosEmitidos(rutReceptor: string, fecha: string): Promise<string | null> {
    const pagina = await this.paginaActiva();
    await pagina.goto(SELECTORES.urlDocumentosEmitidos);
    await pagina.waitForLoadState('networkidle');
    const texto = await pagina.innerText('body');
    const patron = new RegExp(`${rutReceptor.split('-')[0]}[\\s\\S]{0,120}?folio\\s*n?[°º]?\\s*(\\d+)`, 'i');
    const m = patron.exec(texto);
    void fecha; // la fecha se verifica visualmente en el navegador visible
    return m ? (m[1] as string) : null;
  }

  async cerrar(): Promise<void> {
    await this.navegador?.close();
    this.navegador = null;
    this.pagina = null;
  }
}
