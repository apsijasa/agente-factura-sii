// src/services/solicitudes.ts
// Facturas puntuales solicitadas por Telegram: parseo del comando /factura y
// resolución del cliente contra el maestro del Excel. El webhook guarda el
// texto crudo; aquí vive TODA la interpretación (testeada), y los errores son
// mensajes pensados para leerse en el propio chat.
import { esRutValido, normalizarRut } from '../domain/rut.js';
import { parsearDestinatarios } from '../domain/validacion.js';
import type { Cliente, Moneda } from '../domain/tipos.js';

export interface SolicitudParseada {
  clienteTexto: string;
  moneda: Moneda;
  monto: number;
  glosa: string;
}

export interface SolicitudClienteParseada {
  rut: string;
  email: string;
  razonSocial: string;
}

const FORMATO =
  'Formato: /factura <cliente> <monto> <descripción>\n' +
  'Ejemplos: /factura CLI-022 250000 Asesoría contable · /factura "SOCIEDAD PM" 33,5UF Consultoría';

export function parsearSolicitudFactura(texto: string): SolicitudParseada {
  const limpio = texto.trim();
  if (!limpio.startsWith('/factura')) {
    throw new Error(`La solicitud debe comenzar con /factura.\n${FORMATO}`);
  }
  const resto = limpio.slice('/factura'.length).trim();

  // Cliente: entre comillas (nombres con espacios) o un solo token.
  let clienteTexto: string;
  let despuesCliente: string;
  const conComillas = /^"([^"]+)"\s+(.*)$/s.exec(resto) ?? /^“([^”]+)”\s+(.*)$/s.exec(resto);
  if (conComillas) {
    clienteTexto = (conComillas[1] as string).trim();
    despuesCliente = (conComillas[2] as string).trim();
  } else {
    const partes = resto.split(/\s+/);
    clienteTexto = partes[0] ?? '';
    despuesCliente = partes.slice(1).join(' ');
  }
  if (!clienteTexto) throw new Error(`Falta el cliente.\n${FORMATO}`);

  const [montoCrudo, ...glosaPartes] = despuesCliente.split(/\s+/);
  const glosa = glosaPartes.join(' ').trim();
  if (!montoCrudo) throw new Error(`Falta el monto.\n${FORMATO}`);
  if (glosa.length < 3) {
    throw new Error(`Falta la descripción del servicio (será la glosa de la factura).\n${FORMATO}`);
  }

  const esUf = /uf$/i.test(montoCrudo);
  const numeroCrudo = montoCrudo.replace(/uf$/i, '').replace(/^\$/, '');
  let monto: number;
  let moneda: Moneda;
  if (esUf) {
    moneda = 'UF';
    monto = Number(numeroCrudo.replace(/\./g, (m, i: number) =>
      // En UF el separador decimal puede ser coma o punto; no hay miles.
      i === numeroCrudo.lastIndexOf('.') ? '.' : m,
    ).replace(',', '.'));
  } else {
    moneda = 'CLP';
    if (/[,]/.test(numeroCrudo) && !/^\d{1,3}(\.\d{3})*$/.test(numeroCrudo)) {
      throw new Error(`El monto CLP debe ser entero (sin decimales): "${montoCrudo}".\n${FORMATO}`);
    }
    monto = Number(numeroCrudo.replace(/\./g, ''));
    if (!Number.isInteger(monto)) {
      throw new Error(`El monto CLP debe ser entero (sin decimales): "${montoCrudo}".\n${FORMATO}`);
    }
  }
  if (!Number.isFinite(monto) || monto <= 0) {
    throw new Error(`Monto inválido: "${montoCrudo}". Debe ser un número positivo (neto, sin IVA).\n${FORMATO}`);
  }
  return { clienteTexto, moneda, monto, glosa };
}

export function resolverCliente(clientes: Cliente[], clienteTexto: string): Cliente {
  const activos = clientes.filter((c) => c.activo);
  const buscado = clienteTexto.trim().toLowerCase();
  const porId = activos.find((c) => c.cliente_id.toLowerCase() === buscado);
  if (porId) return porId;
  const porNombre = activos.filter((c) => c.razon_social.toLowerCase().includes(buscado));
  if (porNombre.length === 1) return porNombre[0] as Cliente;
  if (porNombre.length > 1) {
    const candidatos = porNombre.map((c) => `${c.cliente_id} (${c.razon_social})`).join(', ');
    throw new Error(`Cliente ambiguo: "${clienteTexto}" coincide con ${candidatos}. Use el cliente_id exacto.`);
  }
  throw new Error(
    `Cliente no encontrado: "${clienteTexto}". Use el cliente_id (ej. CLI-022) o parte única de la razón social ` +
      'de un cliente ACTIVO de tblClientes.',
  );
}

const FORMATO_CLIENTE =
  'Formato: /cliente-nuevo <rut> <correo> <razón social>\n' +
  'Ejemplo: /cliente-nuevo 78123456-7 pagos@fulano.cl Constructora Fulano SpA';

/**
 * Alta de un cliente puntual desde Telegram. Solo pide los tres datos que el
 * padrón del SII NO puede dar: el RUT (para buscarlo), el correo (para enviar
 * el PDF) y la razón social (para que el operador vea a quién le factura en el
 * mensaje de aprobación, antes de que exista documento alguno).
 *
 * Giro, dirección, comuna y ciudad se dejan vacíos a propósito: el formulario
 * del SII los precarga desde el RUT al emitir (`sii-adapter.ts`, el blur del
 * DV), y el libro solo los usa como respaldo.
 */
export function parsearSolicitudCliente(texto: string): SolicitudClienteParseada {
  const limpio = texto.trim();
  if (!limpio.startsWith('/cliente-nuevo')) {
    throw new Error(`La solicitud debe comenzar con /cliente-nuevo.\n${FORMATO_CLIENTE}`);
  }
  const [rutCrudo, emailCrudo, ...resto] = limpio.slice('/cliente-nuevo'.length).trim().split(/\s+/);

  if (!rutCrudo) throw new Error(`Falta el RUT.\n${FORMATO_CLIENTE}`);
  // El dígito verificador es la única defensa contra un dedazo antes de emitir:
  // un RUT mal tipeado que igual exista le factura a un desconocido.
  const rut = normalizarRut(rutCrudo);
  if (!rut || !esRutValido(rut)) {
    throw new Error(`RUT inválido (dígito verificador no calza): "${rutCrudo}".\n${FORMATO_CLIENTE}`);
  }

  if (!emailCrudo) throw new Error(`Falta el correo de facturación.\n${FORMATO_CLIENTE}`);
  try {
    parsearDestinatarios(emailCrudo);
  } catch {
    throw new Error(`Correo inválido: "${emailCrudo}".\n${FORMATO_CLIENTE}`);
  }

  const razonSocial = resto.join(' ').trim();
  if (razonSocial.length < 3) {
    throw new Error(`Falta la razón social del cliente.\n${FORMATO_CLIENTE}`);
  }

  return { rut, email: emailCrudo, razonSocial };
}

const RE_CLIENTE_ID = /^CLI-(\d+)$/i;

/** Siguiente correlativo libre de tblClientes, conservando el ancho (CLI-032). */
export function siguienteClienteId(existentes: string[]): string {
  const numeros = existentes
    .map((id) => RE_CLIENTE_ID.exec(id.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
  const siguiente = (numeros.length === 0 ? 0 : Math.max(...numeros)) + 1;
  return `CLI-${String(siguiente).padStart(3, '0')}`;
}

/**
 * Nombre de carpeta para los PDFs del cliente. Va a parar a la clave de R2
 * (`facturas/<carpeta>/AAAA/MM/...`), y el Worker rechaza claves con '/' o
 * '..' — una razón social sin sanear haría fallar la subida justo después de
 * tener folio, que es el peor momento para fallar.
 */
export function carpetaDesdeRazonSocial(razonSocial: string): string {
  const limpio = razonSocial
    .replace(/[/\\]/g, ' ')
    .replace(/\.{2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return limpio || 'SIN NOMBRE';
}
