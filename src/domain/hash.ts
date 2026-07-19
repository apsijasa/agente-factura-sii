// src/domain/hash.ts
import { createHash } from 'node:crypto';
import type { InvoicePayload } from './tipos.js';

export function jsonCanonico(valor: unknown): string {
  if (valor === null || typeof valor !== 'object') return JSON.stringify(valor);
  if (Array.isArray(valor)) return `[${valor.map(jsonCanonico).join(',')}]`;
  const claves = Object.keys(valor as Record<string, unknown>).sort();
  const partes = claves.map(
    (k) => `${JSON.stringify(k)}:${jsonCanonico((valor as Record<string, unknown>)[k])}`,
  );
  return `{${partes.join(',')}}`;
}

export function hashPayload(payload: InvoicePayload): string {
  return createHash('sha256').update(jsonCanonico(payload), 'utf8').digest('hex');
}
