// src/adapters/graph/reintentos.ts
export class EsReintentableError extends Error {}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    mensaje: string,
  ) {
    super(mensaje);
    this.name = 'HttpError';
  }
}

export const HTTP_TIMEOUT_MS = 30_000;

const ERROR_RED_REINTENTABLE = /fetch failed|ETIMEDOUT|ECONNRESET|TimeoutError|aborted/;

export interface OpcionesReintento {
  intentos: number;
  baseMs: number;
}

function esReintentable(error: unknown): boolean {
  if (error instanceof EsReintentableError) return true;
  if (error instanceof HttpError) {
    return error.status === 429 || (error.status >= 500 && error.status < 600);
  }
  // Solo errores que NO son HttpError se clasifican por mensaje (fallas de red),
  // para no interpretar cuerpos de respuesta no confiables.
  return error instanceof Error && ERROR_RED_REINTENTABLE.test(error.message);
}

export async function conReintentos<T>(
  fn: () => Promise<T>,
  { intentos, baseMs }: OpcionesReintento,
): Promise<T> {
  if (intentos <= 0) {
    throw new Error(`Cantidad de intentos inválida: ${intentos}; debe ser al menos 1`);
  }
  let ultimoError: unknown;
  for (let intento = 1; intento <= intentos; intento++) {
    try {
      return await fn();
    } catch (error) {
      ultimoError = error;
      if (!esReintentable(error) || intento === intentos) throw error;
      const espera = baseMs * 2 ** (intento - 1) * (1 + Math.random() * 0.3);
      await new Promise((r) => setTimeout(r, espera));
    }
  }
  throw ultimoError;
}
