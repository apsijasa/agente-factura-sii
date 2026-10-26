// src/services/token-aprobacion.ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Token firmado (HMAC-SHA256) que viaja en el enlace de aprobación remota.
 * Va ligado al contenido exacto (payload_hash): si el Excel cambia después de
 * la notificación, la Edge Function rechaza la aprobación porque el hash de la
 * factura ya no coincide. La Edge Function `aprobar` verifica este mismo
 * formato con Web Crypto en Deno.
 */
export interface DatosToken {
  facturaId: string;
  payloadHash: string;
  expiraEn: string; // ISO-8601
}

function firmar(cuerpo: string, secreto: string): string {
  return createHmac('sha256', secreto).update(cuerpo).digest('base64url');
}

export function crearToken(datos: DatosToken, secreto: string): string {
  const cuerpo = Buffer.from(JSON.stringify(datos)).toString('base64url');
  return `${cuerpo}.${firmar(cuerpo, secreto)}`;
}

export function verificarToken(token: string, secreto: string, ahora: Date): DatosToken {
  const partes = token.split('.');
  if (partes.length !== 2 || !partes[0] || !partes[1]) {
    throw new Error('Token de aprobación inválido (formato)');
  }
  const [cuerpo, firma] = partes as [string, string];
  const esperada = firmar(cuerpo, secreto);
  const a = Buffer.from(firma);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Token de aprobación inválido (firma)');
  }
  let datos: DatosToken;
  try {
    datos = JSON.parse(Buffer.from(cuerpo, 'base64url').toString()) as DatosToken;
  } catch {
    throw new Error('Token de aprobación inválido (contenido)');
  }
  if (!datos.facturaId || !datos.payloadHash || !datos.expiraEn) {
    throw new Error('Token de aprobación inválido (campos)');
  }
  // NaN no vence nunca (`ahora > NaN` es false); un vencimiento ilegible es token inválido.
  const vence = new Date(datos.expiraEn).getTime();
  if (Number.isNaN(vence)) throw new Error('Token de aprobación inválido (vencimiento)');
  if (ahora.getTime() > vence) {
    throw new Error('El enlace de aprobación expiró; espere la próxima notificación');
  }
  return datos;
}
