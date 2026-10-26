// src/adapters/sii/reintento-red.ts
// Reintento acotado ante cortes de conexión del portal del SII ANTES de llenar
// el formulario. El 26-10-2026 el portal cortó la conexión dos veces al navegar
// a mipeSelEmpresa.cgi (net::ERR_CONNECTION_RESET), en CLI-022 y CLI-027; ambas
// salieron al reintentar a mano, repitiendo el ciclo completo.
//
// Es seguro porque ocurre antes de escribir nada y mucho antes de firmar: no
// deja documento. El invariante de "una sola emisión" protege el tramo
// POSTERIOR al clic de firma (`emitirUnaVez`), y este módulo no lo toca.

const CORTE_DE_CONEXION = /net::ERR_CONNECTION_RESET|net::ERR_CONNECTION_CLOSED|net::ERR_NETWORK_CHANGED|net::ERR_EMPTY_RESPONSE/;

/** Solo cortes de red del navegador; cualquier otro error (empresa equivocada, timeout, captcha) no se reintenta. */
export function esCorteDeConexion(error: unknown): boolean {
  return error instanceof Error && CORTE_DE_CONEXION.test(error.message);
}

export interface OpcionesReintentoRed {
  intentos: number;
  esperaMs: number;
  dormir?: (ms: number) => Promise<void>;
  avisar?: (mensaje: string) => void;
}

const dormirReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function conReintentoDeRed<T>(fn: () => Promise<T>, opciones: OpcionesReintentoRed): Promise<T> {
  const { intentos, esperaMs, dormir = dormirReal, avisar = () => undefined } = opciones;
  if (intentos < 1) throw new Error(`Cantidad de intentos inválida: ${intentos}; debe ser al menos 1`);
  let ultimoError: unknown;
  for (let intento = 1; intento <= intentos; intento++) {
    try {
      return await fn();
    } catch (error) {
      ultimoError = error;
      if (!esCorteDeConexion(error) || intento === intentos) throw error;
      const espera = esperaMs * intento;
      avisar(`el portal del SII cortó la conexión (intento ${intento} de ${intentos}); se reintenta en ${espera / 1000} s`);
      await dormir(espera);
    }
  }
  throw ultimoError;
}
