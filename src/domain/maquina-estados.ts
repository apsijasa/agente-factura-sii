// src/domain/maquina-estados.ts
import type { Estado } from './tipos.js';

export const TRANSICIONES: Record<Estado, readonly Estado[]> = {
  BORRADOR: ['PENDIENTE_APROBACION', 'REQUIERE_REVISION', 'CANCELADA'],
  PENDIENTE_APROBACION: ['APROBADA', 'CANCELADA', 'REQUIERE_REVISION'],
  APROBADA: ['EMITIENDO', 'CANCELADA', 'REQUIERE_REVISION'],
  EMITIENDO: ['EMITIDA', 'REQUIERE_REVISION'],
  EMITIDA: ['DESCARGADA', 'ERROR_REINTENTABLE'],
  DESCARGADA: ['ENVIADA', 'ERROR_REINTENTABLE'],
  ENVIADA: [],
  ERROR_REINTENTABLE: ['DESCARGADA', 'ENVIADA', 'REQUIERE_REVISION'],
  REQUIERE_REVISION: [],
  CANCELADA: [],
};

export function puedeTransicionar(desde: Estado, hacia: Estado): boolean {
  return TRANSICIONES[desde].includes(hacia);
}

export function assertTransicion(desde: Estado, hacia: Estado): void {
  if (!puedeTransicionar(desde, hacia)) {
    throw new Error(`Transición prohibida: ${desde} -> ${hacia}`);
  }
}
