// src/domain/agrupacion.ts
import { esVigente, estaAtrasada, fechaProgramada, periodoDe } from './fechas.js';
import type { CobroRecurrente } from './tipos.js';

export interface GrupoFacturable {
  clave: string;
  empresaId: string;
  clienteId: string;
  periodo: string;
  fechaProgramada: string;
  cobros: CobroRecurrente[];
}

export interface GrupoBloqueado {
  empresaId: string;
  clienteId: string;
  periodo: string;
  motivo: string;
  cobroIds: string[];
}

export interface GrupoAtrasado extends GrupoBloqueado {
  fechaProgramada: string;
}

export function claveFactura(empresaId: string, clienteId: string, periodo: string): string {
  return `RECURRENT:${empresaId}:${clienteId}:${periodo}`;
}

export function agruparCobros(
  cobros: CobroRecurrente[],
  fechaSolicitada: string,
  hoy: string,
): { grupos: GrupoFacturable[]; bloqueados: GrupoBloqueado[]; atrasados: GrupoAtrasado[] } {
  const periodo = periodoDe(fechaSolicitada);
  const elegibles = cobros.filter(
    (c) => c.activo && c.frecuencia === 'MENSUAL' && esVigente(c, fechaSolicitada),
  );

  const porGrupo = new Map<string, CobroRecurrente[]>();
  for (const c of elegibles) {
    const clave = `${c.empresa_id}|${c.cliente_id}`;
    porGrupo.set(clave, [...(porGrupo.get(clave) ?? []), c]);
  }

  const grupos: GrupoFacturable[] = [];
  const bloqueados: GrupoBloqueado[] = [];
  const atrasados: GrupoAtrasado[] = [];

  for (const [, lista] of porGrupo) {
    const ordenada = [...lista].sort((a, b) => a.cobro_id.localeCompare(b.cobro_id));
    const primero = ordenada[0] as CobroRecurrente;
    const base = {
      empresaId: primero.empresa_id,
      clienteId: primero.cliente_id,
      periodo,
      cobroIds: ordenada.map((c) => c.cobro_id),
    };

    const dias = new Set(ordenada.map((c) => c.dia_emision));
    if (dias.size > 1) {
      bloqueados.push({ ...base, motivo: `dia_emision inconsistente: ${[...dias].join(', ')}` });
      continue;
    }

    const programada = fechaProgramada(periodo, primero.dia_emision);
    if (programada === fechaSolicitada) {
      grupos.push({
        clave: claveFactura(base.empresaId, base.clienteId, periodo),
        empresaId: base.empresaId,
        clienteId: base.clienteId,
        periodo,
        fechaProgramada: programada,
        cobros: ordenada,
      });
    } else if (estaAtrasada(programada, hoy)) {
      atrasados.push({
        ...base,
        fechaProgramada: programada,
        motivo: `período ${periodo} atrasado: programada ${programada}, hoy ${hoy}`,
      });
    }
  }

  return { grupos, bloqueados, atrasados };
}
