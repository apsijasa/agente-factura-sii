// src/config/keychain.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const ejecutar = promisify(execFile);
const SERVICIO = 'agente-factura-sii';

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
