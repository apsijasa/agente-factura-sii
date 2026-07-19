// src/adapters/graph/reintentos.ts
export class EsReintentableError extends Error {}

export interface OpcionesReintento {
  intentos: number;
  baseMs: number;
}

export async function conReintentos<T>(
  fn: () => Promise<T>,
  { intentos, baseMs }: OpcionesReintento,
): Promise<T> {
  let ultimoError: unknown;
  for (let intento = 1; intento <= intentos; intento++) {
    try {
      return await fn();
    } catch (error) {
      ultimoError = error;
      const reintentable =
        error instanceof EsReintentableError ||
        (error instanceof Error && /HTTP (429|5\d\d)|fetch failed|ETIMEDOUT|ECONNRESET/.test(error.message));
      if (!reintentable || intento === intentos) throw error;
      const espera = baseMs * 2 ** (intento - 1) * (1 + Math.random() * 0.3);
      await new Promise((r) => setTimeout(r, espera));
    }
  }
  throw ultimoError;
}
