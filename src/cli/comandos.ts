// src/cli/comandos.ts
import { hashPayload } from '../domain/hash.js';
import { agruparCobros } from '../domain/agrupacion.js';
import { construirPayload, type ClasificacionEmisor } from '../domain/motor.js';
import { esquemaCliente, esquemaCobro, esquemaEmpresa } from '../domain/validacion.js';
import type { InvoicePayload } from '../domain/tipos.js';
import type { ExcelAdapter } from '../adapters/excel/excel-adapter.js';
import type { UfProvider } from '../adapters/uf/uf-provider.js';
import { EmisionConfirmadaSinPdfError, type ISiiAdapter } from '../adapters/sii/sii-adapter.js';
import type { MailService } from '../services/correo.js';
import { resumenAprobacion, type IAprobacion } from '../services/aprobacion.js';
import { crearToken } from '../services/token-aprobacion.js';
import type { CanalNotificacion } from '../services/notificador.js';
import { parsearSolicitudFactura, resolverCliente } from '../services/solicitudes.js';
import type { RepoSolicitudes } from '../store/solicitudes-supabase.js';
import { periodoDe } from '../domain/fechas.js';
import type { CobroRecurrente } from '../domain/tipos.js';
import type { GrupoFacturable } from '../domain/agrupacion.js';
import type { AlmacenPdf } from '../services/almacen-pdf.js';
import { filaExcelDesdePayload } from '../store/facturas-repository.js';
import type { IAuditStore } from '../store/audit-store.js';
import { logger } from '../services/logger.js';

export interface Dependencias {
  store: IAuditStore;
  excel: ExcelAdapter;
  uf: UfProvider;
  sii: ISiiAdapter;
  correo: MailService;
  aprobacion: IAprobacion;
  clasificaciones: Record<string, ClasificacionEmisor>;
  pdfs: AlmacenPdf;
  hoy: () => string;
}

export interface ResultadoPrepare {
  preparadas: string[];
  omitidas: string[];
  bloqueadas: string[];
  atrasadas: string[];
}

export async function ejecutarPrepare(deps: Dependencias, fecha?: string): Promise<ResultadoPrepare> {
  const fechaObjetivo = fecha ?? deps.hoy();
  const empresas = (await deps.excel.leerTabla('tblEmpresas')).map((f) => esquemaEmpresa.parse(f));
  const clientes = (await deps.excel.leerTabla('tblClientes')).map((f) => esquemaCliente.parse(f));
  const cobros = (await deps.excel.leerTabla('tblCobrosRecurrentes')).map((f) => esquemaCobro.parse(f));

  const { grupos, bloqueados, atrasados } = agruparCobros(cobros, fechaObjetivo, deps.hoy());
  const resultado: ResultadoPrepare = {
    preparadas: [],
    omitidas: [],
    bloqueadas: bloqueados.map((b) => `${b.empresaId}/${b.clienteId}: ${b.motivo}`),
    atrasadas: atrasados.map((a) => `${a.empresaId}/${a.clienteId}: ${a.motivo}`),
  };

  for (const grupo of grupos) {
    if (await deps.store.obtenerFactura(grupo.clave)) {
      resultado.omitidas.push(grupo.clave);
      continue;
    }
    const empresa = empresas.find((e) => e.empresa_id === grupo.empresaId && e.activo);
    const cliente = clientes.find((c) => c.cliente_id === grupo.clienteId && c.activo);
    const clasificacion = deps.clasificaciones[grupo.empresaId];
    if (!empresa || !cliente || !clasificacion) {
      throw new Error(`Datos maestros incompletos para el grupo ${grupo.clave}`);
    }
    const requiereUf = grupo.cobros.some((c) => c.moneda === 'UF');
    const uf = requiereUf ? await deps.uf.obtenerValorUf(grupo.fechaProgramada) : null;
    const payload = construirPayload(grupo, empresa, cliente, clasificacion, uf?.valor ?? null);
    await deps.store.crearFactura(payload, hashPayload(payload));
    // Diseño §5 UfProvider: la procedencia del valor UF (valor, fecha, URL de
    // origen y momento de consulta) queda auditada en state_events.
    const detalle = uf
      ? `preparación en simulación; UF ${uf.valor} (${uf.fecha}) de ${uf.url} consultada ${uf.consultadoEn}`
      : 'preparación en simulación';
    if (uf) logger.info({ facturaId: payload.factura_id, uf }, 'valor UF registrado con procedencia');
    await deps.store.registrarTransicion(payload.factura_id, 'PENDIENTE_APROBACION', detalle);
    await deps.excel.agregarFilaFacturas(filaExcelDesdePayload(payload, 'PENDIENTE_APROBACION'));
    resultado.preparadas.push(payload.factura_id);
  }

  logger.info({ resultado }, 'prepare completado');
  return resultado;
}

/**
 * Refleja cambios en Excel dentro de una rama de error SIN enmascarar el
 * error original: si Excel falla, se registra una advertencia (redactada por
 * el hook del logger) y el flujo continúa hacia el rethrow del error real.
 */
async function reflejarErrorEnExcel(
  deps: Dependencias,
  facturaId: string,
  cambios: Parameters<ExcelAdapter['actualizarFilaFacturas']>[1],
): Promise<void> {
  try {
    await deps.excel.actualizarFilaFacturas(facturaId, cambios);
  } catch (error) {
    logger.warn(`No se pudo reflejar ${facturaId} en Excel: ${(error as Error).message}`);
  }
}

async function payloadDesdeStore(deps: Dependencias, facturaId: string): Promise<InvoicePayload> {
  const fila = await deps.store.obtenerFactura(facturaId);
  if (!fila) throw new Error(`Factura no encontrada: ${facturaId}`);
  return JSON.parse(fila.payload_json) as InvoicePayload;
}

export async function ejecutarPreviewSii(deps: Dependencias, facturaId: string): Promise<void> {
  const fila = await deps.store.obtenerFactura(facturaId);
  if (!fila) throw new Error(`Factura no encontrada: ${facturaId}`);
  const payload = await payloadDesdeStore(deps, facturaId);
  if (hashPayload(payload) !== fila.payload_hash) {
    throw new Error('El payload cambió desde la preparación; regenerar con prepare');
  }
  await deps.sii.abrirYPreparar(payload);
  const preview = await deps.sii.extraerPreview(payload);
  if (!preview.coinciden) {
    await deps.store.registrarTransicion(facturaId, 'REQUIERE_REVISION', preview.diferencias.join(' | '));
    await reflejarErrorEnExcel(deps, facturaId, { estado: 'REQUIERE_REVISION', error: preview.diferencias.join(' | ') });
    throw new Error(`Los totales del SII no coinciden: ${preview.diferencias.join(' | ')}`);
  }
  logger.info({ facturaId, totales: preview.totales }, 'vista previa SII coincide; detenido antes de emitir');
}

export async function ejecutarEmit(deps: Dependencias, facturaId: string): Promise<void> {
  const fila = await deps.store.obtenerFactura(facturaId);
  if (!fila) throw new Error(`Factura no encontrada: ${facturaId}`);
  if (fila.estado !== 'PENDIENTE_APROBACION') {
    throw new Error(`La factura está en ${fila.estado}; emit exige PENDIENTE_APROBACION`);
  }
  const payload = await payloadDesdeStore(deps, facturaId);
  if (hashPayload(payload) !== fila.payload_hash) {
    throw new Error('El payload cambió desde la preparación; regenerar con prepare');
  }

  const carpeta = payload.nombre_carpeta;
  const rutaPrevista = deps.pdfs.rutaPrevista(carpeta, payload.fecha_emision);

  await deps.sii.abrirYPreparar(payload);
  const preview = await deps.sii.extraerPreview(payload);
  if (!preview.coinciden) {
    await deps.store.registrarTransicion(facturaId, 'REQUIERE_REVISION', preview.diferencias.join(' | '));
    await reflejarErrorEnExcel(deps, facturaId, { estado: 'REQUIERE_REVISION', error: preview.diferencias.join(' | ') });
    throw new Error(`Los totales del SII no coinciden; REQUIERE_REVISION: ${preview.diferencias.join(' | ')}`);
  }

  const aprobacion = await deps.aprobacion.solicitarAprobacion(payload, rutaPrevista);
  if (!aprobacion.aprobada) {
    throw new Error('Aprobación denegada o texto incorrecto; no se emite');
  }
  // Guarda TOCTOU: la aprobación humana puede tardar minutos; se relee la fila
  // y se verifica que nada cambió entre la aprobación y la emisión.
  const filaFresca = await deps.store.obtenerFactura(facturaId);
  if (!filaFresca) {
    throw new Error(`La factura ${facturaId} desapareció durante la aprobación; no se emite`);
  }
  if (filaFresca.estado !== 'PENDIENTE_APROBACION') {
    throw new Error(`La factura cambió a ${filaFresca.estado} durante la aprobación; no se emite`);
  }
  if (hashPayload(payload) !== filaFresca.payload_hash) {
    throw new Error('El payload cambió durante la aprobación; no se emite');
  }
  await deps.store.registrarAprobacion(facturaId, aprobacion.actor, filaFresca.payload_hash, aprobacion.fecha);
  await deps.store.registrarTransicion(facturaId, 'APROBADA', `aprobada por ${aprobacion.actor}`);
  await deps.store.registrarTransicion(facturaId, 'EMITIENDO', 'única acción de emisión');

  let emision;
  try {
    emision = await deps.sii.emitirUnaVez();
  } catch (error) {
    // Deviación autorizada respecto al plan original: si la emisión fue
    // CONFIRMADA por el SII (hay folio) pero falló solo la descarga del PDF,
    // NO es una respuesta incierta. El folio se preserva y la factura queda
    // en ERROR_REINTENTABLE (EMITIDA -> ERROR_REINTENTABLE es transición
    // legal) para que únicamente `retry-email`/descarga manual la retomen;
    // jamás debe volver a pasar por `emitirUnaVez`.
    if (error instanceof EmisionConfirmadaSinPdfError) {
      const detalle = `PDF pendiente: ${error.message}`;
      await deps.store.registrarTransicion(facturaId, 'EMITIDA', `folio ${error.folio}`);
      await deps.store.guardarFolio(facturaId, error.folio);
      await deps.store.registrarTransicion(facturaId, 'ERROR_REINTENTABLE', detalle);
      await reflejarErrorEnExcel(deps, facturaId, {
        estado: 'ERROR_REINTENTABLE', folio_sii: error.folio, error: detalle,
      });
      throw error;
    }

    // Respuesta incierta: consultar documentos emitidos antes de permitir otra acción (diseño §5 SiiAdapter).
    // La consulta puede fallar (p. ej. navegador cerrado): eso NUNCA debe
    // impedir que la factura quede registrada en REQUIERE_REVISION.
    let folioExistente: string | null = null;
    let notaConsulta = '';
    try {
      folioExistente = await deps.sii.consultarDocumentosEmitidos(payload.rut_cliente, payload.fecha_emision);
    } catch (errorConsulta) {
      notaConsulta = `; consulta de documentos emitidos falló: ${(errorConsulta as Error).message}`;
    }
    const detalle = folioExistente
      ? `emisión incierta; documentos emitidos muestra folio ${folioExistente}`
      : `emisión incierta sin folio visible: ${(error as Error).message}${notaConsulta}`;
    // El folio hallado se persiste ANTES de la transición terminal: es la única
    // evidencia de que el documento existe y no puede perderse.
    if (folioExistente) await deps.store.guardarFolio(facturaId, folioExistente);
    await deps.store.registrarTransicion(facturaId, 'REQUIERE_REVISION', detalle);
    await reflejarErrorEnExcel(deps, facturaId, {
      estado: 'REQUIERE_REVISION',
      error: detalle,
      ...(folioExistente ? { folio_sii: folioExistente } : {}),
    });
    throw new Error(detalle);
  }

  await deps.store.registrarTransicion(facturaId, 'EMITIDA', `folio ${emision.folio}`);
  await deps.store.guardarFolio(facturaId, emision.folio);

  let rutaFinal: string;
  try {
    rutaFinal = await deps.pdfs.guardarFactura(carpeta, payload.fecha_emision, emision.folio, emision.pdf);
  } catch (error) {
    await deps.store.registrarTransicion(facturaId, 'ERROR_REINTENTABLE', `PDF: ${(error as Error).message}`);
    await reflejarErrorEnExcel(deps, facturaId, { estado: 'ERROR_REINTENTABLE', folio_sii: emision.folio, error: (error as Error).message });
    throw error;
  }
  await deps.store.guardarRutaPdf(facturaId, rutaFinal);
  await deps.store.registrarTransicion(facturaId, 'DESCARGADA', rutaFinal);

  try {
    await deps.correo.enviarFactura({
      remitente: payload.remitente,
      destinatarios: payload.destinatarios,
      copia: payload.copia,
      asunto: `Factura ${emision.folio} — ${payload.razon_social_emisor} — ${payload.periodo}`,
      cuerpo: `Estimados,\n\nAdjuntamos la factura electrónica N° ${emision.folio} correspondiente al período ${payload.periodo}.\n\nSaludos,\n${payload.razon_social_emisor}`,
      nombreAdjunto: rutaFinal.split('/').pop() as string,
      pdf: emision.pdf,
    });
    await deps.store.registrarIntentoCorreo(facturaId, true, 'enviado');
  } catch (error) {
    await deps.store.registrarIntentoCorreo(facturaId, false, (error as Error).message);
    await deps.store.registrarTransicion(facturaId, 'ERROR_REINTENTABLE', `correo: ${(error as Error).message}`);
    await reflejarErrorEnExcel(deps, facturaId, {
      estado: 'ERROR_REINTENTABLE', folio_sii: emision.folio, pdf_path: rutaFinal, error: (error as Error).message,
    });
    throw error;
  }
  await deps.store.registrarTransicion(facturaId, 'ENVIADA', 'correo enviado');
  await deps.excel.actualizarFilaFacturas(facturaId, {
    estado: 'ENVIADA', folio_sii: emision.folio, pdf_path: rutaFinal,
    aprobada_por: aprobacion.actor, fecha_aprobacion: aprobacion.fecha,
    fecha_envio: new Date().toISOString(), error: '',
  });
}

// Estados desde los que la máquina de estados admite CANCELADA; en todos ellos
// la factura aún no pasó por `emitirUnaVez`, así que cancelar nunca oculta un folio.
const ESTADOS_CANCELABLES: readonly string[] = ['BORRADOR', 'PENDIENTE_APROBACION', 'APROBADA'];

export async function ejecutarCancel(deps: Dependencias, facturaId: string, motivo: string): Promise<void> {
  const fila = await deps.store.obtenerFactura(facturaId);
  if (!fila) throw new Error(`Factura no encontrada: ${facturaId}`);
  const motivoLimpio = motivo.trim();
  if (!motivoLimpio) throw new Error('cancel exige un motivo no vacío (--motivo)');
  if (!ESTADOS_CANCELABLES.includes(fila.estado)) {
    throw new Error(
      `La factura está en ${fila.estado} y no se puede cancelar; solo aplica antes de emitir (${ESTADOS_CANCELABLES.join(', ')})`,
    );
  }
  await deps.store.registrarTransicion(facturaId, 'CANCELADA', motivoLimpio);
  await reflejarErrorEnExcel(deps, facturaId, { estado: 'CANCELADA', error: motivoLimpio });
  logger.info({ facturaId, motivo: motivoLimpio }, 'factura cancelada; ninguna ruta automática puede retomarla');
}

export interface OpcionesNotify {
  urlAprobacion: string;
  secreto: string;
  vigenciaHoras: number;
  ahora: () => Date;
}

/**
 * Ciclo nube (1/2): envía la solicitud de aprobación remota de cada factura
 * PENDIENTE_APROBACION que aún no tiene aprobación registrada. El enlace lleva
 * un token firmado ligado al hash del contenido; si el Excel cambia después,
 * la aprobación no sirve y se re-notifica en el ciclo siguiente.
 */
export async function ejecutarNotify(
  deps: Dependencias,
  canal: CanalNotificacion,
  opciones: OpcionesNotify,
): Promise<string[]> {
  const notificadas: string[] = [];
  for (const facturaId of await deps.store.listarFacturaIds()) {
    const fila = await deps.store.obtenerFactura(facturaId);
    if (fila?.estado !== 'PENDIENTE_APROBACION') continue;
    const aprobacion = await deps.store.obtenerAprobacion(facturaId);
    if (aprobacion && aprobacion.payload_hash === fila.payload_hash) continue;
    const payload = JSON.parse(fila.payload_json) as InvoicePayload;
    const expiraEn = new Date(
      opciones.ahora().getTime() + opciones.vigenciaHoras * 3_600_000,
    ).toISOString();
    const token = crearToken(
      { facturaId, payloadHash: fila.payload_hash, expiraEn },
      opciones.secreto,
    );
    const mensaje =
      `${resumenAprobacion(payload, deps.pdfs.rutaPrevista(payload.nombre_carpeta, payload.fecha_emision))}\n\n` +
      `Para APROBAR la emisión de esta factura abra este enlace:\n` +
      `${opciones.urlAprobacion}?token=${token}\n\n` +
      `Si NO corresponde emitirla, no haga nada: el enlace expira en ${opciones.vigenciaHoras} horas ` +
      `y nada se emite sin su aprobación.`;
    await canal.enviar(mensaje);
    logger.info({ facturaId }, 'solicitud de aprobación remota enviada');
    notificadas.push(facturaId);
  }
  return notificadas;
}

export interface ResultadoSolicitudes {
  procesadas: string[];
  rechazadas: number[];
}

/**
 * Facturas puntuales por Telegram: convierte cada solicitud NUEVA en una
 * factura PUNTUAL:<empresa>:<cliente>:<fecha>:<solicitud> en
 * PENDIENTE_APROBACION — la clave incluye fecha e id para no chocar jamás con
 * el ciclo mensual RECURRENT del mismo cliente/período. La aprobación y la
 * emisión siguen el mismo camino de siempre; aquí no se emite nada.
 */
export async function ejecutarProcesarSolicitudes(
  deps: Dependencias,
  solicitudes: RepoSolicitudes,
  canal: CanalNotificacion,
): Promise<ResultadoSolicitudes> {
  const resultado: ResultadoSolicitudes = { procesadas: [], rechazadas: [] };
  const pendientes = await solicitudes.pendientes();
  if (pendientes.length === 0) return resultado;

  const empresas = (await deps.excel.leerTabla('tblEmpresas')).map((f) => esquemaEmpresa.parse(f));
  const clientes = (await deps.excel.leerTabla('tblClientes')).map((f) => esquemaCliente.parse(f));

  for (const solicitud of pendientes) {
    try {
      const parseada = parsearSolicitudFactura(solicitud.texto);
      const cliente = resolverCliente(clientes, parseada.clienteTexto);
      const empresa = empresas.find((e) => e.activo);
      if (!empresa) throw new Error('No hay empresa activa en tblEmpresas');
      const clasificacion = deps.clasificaciones[empresa.empresa_id];
      if (!clasificacion) throw new Error(`Sin clasificación SII para ${empresa.empresa_id}`);

      const fecha = deps.hoy();
      const clave = `PUNTUAL:${empresa.empresa_id}:${cliente.cliente_id}:${fecha}:${solicitud.id}`;
      const cobro: CobroRecurrente = {
        cobro_id: `TG-${solicitud.id}`,
        empresa_id: empresa.empresa_id,
        cliente_id: cliente.cliente_id,
        descripcion_servicio: parseada.glosa,
        moneda: parseada.moneda,
        monto_neto: parseada.monto,
        cantidad: 1,
        frecuencia: 'MENSUAL',
        dia_emision: Number(fecha.slice(8, 10)),
        forma_pago: 'CONTADO',
        dias_vencimiento: 0,
        fecha_inicio: fecha,
        fecha_fin: fecha,
        activo: true,
      };
      const grupo: GrupoFacturable = {
        clave,
        empresaId: empresa.empresa_id,
        clienteId: cliente.cliente_id,
        periodo: periodoDe(fecha),
        fechaProgramada: fecha,
        cobros: [cobro],
      };
      const uf = parseada.moneda === 'UF' ? await deps.uf.obtenerValorUf(fecha) : null;
      const payload = construirPayload(grupo, empresa, cliente, clasificacion, uf?.valor ?? null);
      await deps.store.crearFactura(payload, hashPayload(payload));
      const detalle = uf
        ? `solicitud Telegram #${solicitud.id}; UF ${uf.valor} (${uf.fecha}) de ${uf.url} consultada ${uf.consultadoEn}`
        : `solicitud Telegram #${solicitud.id}`;
      await deps.store.registrarTransicion(clave, 'PENDIENTE_APROBACION', detalle);
      await deps.excel.agregarFilaFacturas(filaExcelDesdePayload(payload, 'PENDIENTE_APROBACION'));
      await solicitudes.marcarProcesada(solicitud.id, clave);
      logger.info({ facturaId: clave, solicitud: solicitud.id }, 'solicitud Telegram convertida en factura pendiente');
      resultado.procesadas.push(clave);
    } catch (error) {
      const mensaje = (error as Error).message;
      await solicitudes.marcarRechazada(solicitud.id, mensaje);
      await canal.enviar(`⚠️ Solicitud rechazada:\n"${solicitud.texto}"\n\n${mensaje}`);
      logger.warn(`Solicitud Telegram #${solicitud.id} rechazada: ${mensaje}`);
      resultado.rechazadas.push(solicitud.id);
    }
  }
  return resultado;
}

export interface ResultadoEmitAprobadas {
  emitidas: string[];
  fallidas: string[];
}

/**
 * Ciclo nube (2/2): emite únicamente las facturas PENDIENTE_APROBACION cuya
 * aprobación remota existe y coincide con el hash actual del contenido. Cada
 * factura se procesa de forma independiente: un fallo no detiene a las demás,
 * y la fallida queda en el estado que el propio ejecutarEmit le asignó
 * (REQUIERE_REVISION / ERROR_REINTENTABLE), jamás re-emitible en caliente.
 */
export async function ejecutarEmitAprobadas(deps: Dependencias): Promise<ResultadoEmitAprobadas> {
  const resultado: ResultadoEmitAprobadas = { emitidas: [], fallidas: [] };
  for (const facturaId of await deps.store.listarFacturaIds()) {
    const fila = await deps.store.obtenerFactura(facturaId);
    if (fila?.estado !== 'PENDIENTE_APROBACION') continue;
    const aprobacion = await deps.store.obtenerAprobacion(facturaId);
    if (!aprobacion || aprobacion.payload_hash !== fila.payload_hash) continue;
    try {
      await ejecutarEmit(deps, facturaId);
      resultado.emitidas.push(facturaId);
    } catch (error) {
      logger.error(`Emisión de ${facturaId} falló: ${(error as Error).message}`);
      resultado.fallidas.push(facturaId);
    }
  }
  return resultado;
}

export async function ejecutarRetryEmail(deps: Dependencias, facturaId: string): Promise<void> {
  const fila = await deps.store.obtenerFactura(facturaId);
  if (!fila) throw new Error(`Factura no encontrada: ${facturaId}`);
  if (!fila.folio_sii || !fila.pdf_path) {
    throw new Error('retry-email exige folio y PDF verificado; no invoca SiiAdapter');
  }
  if (fila.estado !== 'ERROR_REINTENTABLE' && fila.estado !== 'DESCARGADA') {
    throw new Error(`retry-email no aplica en estado ${fila.estado}`);
  }
  const payload = await payloadDesdeStore(deps, facturaId);
  try {
    const pdf = await deps.pdfs.obtener(fila.pdf_path);
    await deps.correo.enviarFactura({
      remitente: payload.remitente,
      destinatarios: payload.destinatarios,
      copia: payload.copia,
      asunto: `Factura ${fila.folio_sii} — ${payload.razon_social_emisor} — ${payload.periodo}`,
      cuerpo: `Estimados,\n\nAdjuntamos la factura electrónica N° ${fila.folio_sii} correspondiente al período ${payload.periodo}.\n\nSaludos,\n${payload.razon_social_emisor}`,
      nombreAdjunto: fila.pdf_path.split('/').pop() as string,
      pdf,
    });
    await deps.store.registrarIntentoCorreo(facturaId, true, 'reintento exitoso');
    await deps.store.registrarTransicion(facturaId, 'ENVIADA', 'correo enviado en reintento');
    await deps.excel.actualizarFilaFacturas(facturaId, {
      estado: 'ENVIADA',
      folio_sii: fila.folio_sii,
      pdf_path: fila.pdf_path,
      fecha_envio: new Date().toISOString(),
      error: '',
    });
  } catch (error) {
    await deps.store.registrarIntentoCorreo(facturaId, false, (error as Error).message);
    throw error;
  }
}
