// src/cli/lock.ts
import lockfile from 'proper-lockfile';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export async function conBloqueo<T>(rutaDatos: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(rutaDatos, { recursive: true });
  const objetivo = join(rutaDatos, 'agente.lock');
  if (!existsSync(objetivo)) writeFileSync(objetivo, '');
  let liberar: (() => Promise<void>) | null = null;
  try {
    liberar = await lockfile.lock(objetivo, { stale: 15 * 60 * 1000 });
  } catch {
    throw new Error('Otra ejecución del agente está activa; solo un flujo SII puede correr a la vez');
  }
  try {
    return await fn();
  } finally {
    await liberar?.();
  }
}
