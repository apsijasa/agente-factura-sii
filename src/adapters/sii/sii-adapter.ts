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
  private ultimoDialogo: string | null = null;

  constructor(
    private readonly opciones: {
      dirEvidencia: string; // .data/evidence
      timeoutMs: number;
      ciudadEmisor?: string;
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
    // El portal usa alert() para reportar errores de validación; capturamos el
    // mensaje para incluirlo en la evidencia y aceptamos para no bloquear.
    this.pagina.on('dialog', (dialogo) => {
      this.ultimoDialogo = dialogo.message();
      void dialogo.accept().catch(() => undefined);
    });
    return this.pagina;
  }

  async abrirYPreparar(payload: InvoicePayload): Promise<void> {
    const pagina = await this.paginaActiva();
    await pagina.goto(SELECTORES.urlEmisionFactura);
    // El SII redirige primero al login (zeus*.sii.cl/AUT2000). La página de login
    // también tiene un campo "RUT", así que el agente NO debe tocar nada hasta que
    // el operador termine de autenticarse y salga del dominio de autenticación.
    if (/AUT2000|IngresoRutClave/i.test(pagina.url())) {
      console.log(
        'Inicie sesión en la ventana del SII (RUT y clave) y seleccione la empresa si el portal lo pide. El agente esperará…',
      );
      await pagina.waitForURL((url) => !/AUT2000|IngresoRutClave/i.test(url.toString()), {
        timeout: this.opciones.timeoutMs,
      });
    }
    // El retorno post-login no siempre respeta el destino: si no quedamos en el
    // formulario de emisión, navegar de nuevo (ya autenticado). Si aparece la
    // selección de empresa, el operador la elige y el flujo continúa solo.
    if (!/mipeGenFacEx/i.test(pagina.url())) {
      await pagina.goto(SELECTORES.urlEmisionFactura);
      if (/mipeSelEmpresa/i.test(pagina.url())) {
        console.log('Seleccione la empresa en la ventana del SII. El agente esperará…');
      }
    }
    // Autenticado: ahora sí esperar el formulario de emisión y llenarlo.
    // Ante CUALQUIER problema se guarda evidencia local (captura + HTML) en
    // .data/evidence (fuera de Git) para calibrar selectores contra el portal real.
    try {
      await pagina.locator(SELECTORES.campoRutReceptor.id).waitFor({ timeout: this.opciones.timeoutMs });
      await this.guardarEvidencia(pagina, 'formulario-emision');

      // RUT receptor en cuerpo + DV; el blur dispara la búsqueda de datos del
      // receptor en el padrón del SII (razón social, giro, dirección).
      const [cuerpoRut, dvRut] = payload.rut_cliente.split('-') as [string, string];
      await pagina.locator(SELECTORES.campoRutReceptor.id).fill(cuerpoRut);
      await pagina.locator(SELECTORES.campoDvReceptor.id).fill(dvRut);
      await pagina.locator(SELECTORES.campoDvReceptor.id).blur();
      await pagina.waitForTimeout(2000);
      // Si el padrón no completó los datos del receptor, usar los del libro.
      // Si el portal los exige y tampoco están en el libro, la validación del
      // SII lo alertará y la factura quedará en revisión (diseño §4).
      const completarSiVacio = async (selector: string, valor: string): Promise<void> => {
        const actual = await pagina.locator(selector).inputValue();
        if (actual.trim() === '' && valor.trim() !== '') {
          await pagina.locator(selector).fill(valor);
        }
      };
      await completarSiVacio(SELECTORES.campoRazonSocialReceptor, payload.razon_social_cliente);
      await completarSiVacio(SELECTORES.campoGiroReceptor, payload.giro_cliente);
      await completarSiVacio(SELECTORES.campoDireccionReceptor, payload.direccion_cliente);
      await completarSiVacio(SELECTORES.campoComunaReceptor, payload.comuna_cliente);
      await completarSiVacio(SELECTORES.campoCiudadReceptor, payload.ciudad_cliente);
      // Ciudad del emisor: el padrón suele dejarla vacía y el SII la exige.
      if (this.opciones.ciudadEmisor) {
        await completarSiVacio(SELECTORES.campoCiudadOrigen, this.opciones.ciudadEmisor);
      }

      await pagina.locator(SELECTORES.campoFechaEmision).fill(payload.fecha_emision);
      await pagina.locator(SELECTORES.tipoVenta).selectOption({ label: payload.tipo_venta });
      await pagina.locator(SELECTORES.tipoCompra).selectOption({ label: payload.tipo_compra });
      const etiquetaFormaPago = SELECTORES.formaPagoEtiquetas[payload.forma_pago];
      if (!etiquetaFormaPago) throw new Error(`forma_pago sin etiqueta SII: ${payload.forma_pago}`);
      await pagina.locator(SELECTORES.formaPago).selectOption({ label: etiquetaFormaPago });

      for (const [i, linea] of payload.lineas.entries()) {
        if (i > 0) await pagina.locator(SELECTORES.botonAgregarLinea).click();
        await pagina.locator(SELECTORES.lineaNombre(i)).fill(linea.descripcion);
        await pagina.locator(SELECTORES.lineaCantidad(i)).fill(String(linea.cantidad));
        await pagina.locator(SELECTORES.lineaPrecio(i)).fill(String(linea.precio_unitario_clp));
      }
      // El total se recalcula con eventos de teclado; forzar blur antes de validar.
      await pagina.locator(SELECTORES.lineaPrecio(payload.lineas.length - 1)).blur();
      await pagina.waitForTimeout(500);

      this.ultimoDialogo = null;
      await pagina.locator(SELECTORES.botonVistaPrevia).click();
      await pagina.waitForLoadState('networkidle');
      if (this.ultimoDialogo) {
        throw new Error(`El SII rechazó la validación del formulario: ${this.ultimoDialogo}`);
      }
    } catch (error) {
      const base = await this.guardarEvidencia(pagina, 'form-fallo');
      const dialogo = this.ultimoDialogo ? ` | Alerta del portal: ${this.ultimoDialogo}` : '';
      throw new Error(
        `Fallo al completar el formulario de emisión (url actual: ${pagina.url()}). ` +
          `Evidencia guardada en ${base}.png/.html — usarla para calibrar selectores.` +
          dialogo +
          ` Detalle: ${(error as Error).message.split('\n')[0]}`,
      );
    }
  }

  private async guardarEvidencia(pagina: Page, prefijo: string): Promise<string> {
    const base = `${this.opciones.dirEvidencia}/${prefijo}-${Date.now()}`;
    await pagina.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => undefined);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${base}.html`, await pagina.content()).catch(() => undefined);
    return base;
  }

  async extraerPreview(payload: InvoicePayload): Promise<ResultadoPreview> {
    const pagina = await this.paginaActiva();
    // Evidencia de la vista previa siempre, para calibrar la lectura de totales.
    await this.guardarEvidencia(pagina, 'vista-previa');
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
