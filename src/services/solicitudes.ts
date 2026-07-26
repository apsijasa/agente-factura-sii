// src/services/solicitudes.ts
// Facturas puntuales solicitadas por Telegram: parseo del comando /factura y
// resolución del cliente contra el maestro del Excel. El webhook guarda el
// texto crudo; aquí vive TODA la interpretación (testeada), y los errores son
// mensajes pensados para leerse en el propio chat.
import type { Cliente, Moneda } from '../domain/tipos.js';

export interface SolicitudParseada {
  clienteTexto: string;
  moneda: Moneda;
  monto: number;
  glosa: string;
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
