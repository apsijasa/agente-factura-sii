// src/config/keychain.ts
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const ejecutar = promisify(execFile);
const SERVICIO = 'agente-factura-sii';
const CUENTA_CLAVE_CACHE = 'msal-cache-key';

// La credencial se guarda una vez con:
//   security add-generic-password -s agente-factura-sii -a <rut_emisor> -w
// (el flag -w sin valor pide la contraseña de forma interactiva, sin dejarla en el historial)
export async function leerSecretoKeychain(cuenta: string): Promise<string> {
  try {
    const { stdout } = await ejecutar('security', [
      'find-generic-password', '-s', SERVICIO, '-a', cuenta, '-w',
    ]);
    const secreto = stdout.replace(/\n$/, '');
    if (!secreto) throw new Error('vacío');
    return secreto;
  } catch {
    throw new Error(
      `No hay secreto en el llavero para servicio=${SERVICIO} cuenta=${cuenta}. ` +
        `Guárdelo con: security add-generic-password -s ${SERVICIO} -a ${cuenta} -w`,
    );
  }
}

async function guardarSecretoKeychain(cuenta: string, valor: string): Promise<void> {
  // -U actualiza si ya existe. execFile no pasa por shell, así el valor no
  // queda en el historial; la exposición en argv es local y momentánea.
  await ejecutar('security', ['add-generic-password', '-U', '-s', SERVICIO, '-a', cuenta, '-w', valor]);
}

// Llave AES-256 para el cache de tokens MSAL: se crea una vez y vive solo en
// el llavero de macOS.
export async function obtenerOCrearClaveCifrado(): Promise<Buffer> {
  try {
    const clave = Buffer.from(await leerSecretoKeychain(CUENTA_CLAVE_CACHE), 'base64');
    if (clave.length === 32) return clave;
  } catch {
    // no existe todavía
  }
  const nueva = randomBytes(32);
  await guardarSecretoKeychain(CUENTA_CLAVE_CACHE, nueva.toString('base64'));
  return nueva;
}
