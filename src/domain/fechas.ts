// src/domain/fechas.ts
export function periodoDe(fechaIso: string): string {
  return fechaIso.slice(0, 7);
}

export function fechaProgramada(periodo: string, diaEmision: number): string {
  if (!Number.isInteger(diaEmision) || diaEmision < 1 || diaEmision > 28) {
    throw new Error(`dia_emision debe estar entre 1 y 28, recibido: ${diaEmision}`);
  }
  return `${periodo}-${String(diaEmision).padStart(2, '0')}`;
}

export function esVigente(
  cobro: { fecha_inicio: string; fecha_fin: string | null },
  fechaIso: string,
): boolean {
  if (fechaIso < cobro.fecha_inicio) return false;
  if (cobro.fecha_fin && fechaIso > cobro.fecha_fin) return false;
  return true;
}

export function estaAtrasada(fechaProgramadaIso: string, hoyIso: string): boolean {
  return fechaProgramadaIso < hoyIso;
}

export function fechaVencimiento(
  fechaEmisionIso: string,
  formaPago: 'CONTADO' | 'CREDITO',
  diasVencimiento: number,
): string {
  if (formaPago === 'CONTADO') {
    if (diasVencimiento !== 0) throw new Error('CONTADO exige dias_vencimiento = 0');
    return fechaEmisionIso;
  }
  const fecha = new Date(`${fechaEmisionIso}T00:00:00Z`);
  fecha.setUTCDate(fecha.getUTCDate() + diasVencimiento);
  return fecha.toISOString().slice(0, 10);
}
