// src/domain/rut.ts
export function normalizarRut(entrada: string): string | null {
  const limpio = entrada.replace(/[.\s]/g, '').toUpperCase();
  const m = /^(\d{1,8})-([\dK])$/.exec(limpio);
  return m ? `${m[1]}-${m[2]}` : null;
}

export function calcularDv(cuerpo: string): string {
  let suma = 0;
  let factor = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const resto = 11 - (suma % 11);
  if (resto === 11) return '0';
  if (resto === 10) return 'K';
  return String(resto);
}

export function esRutValido(entrada: string): boolean {
  const norm = normalizarRut(entrada);
  if (!norm) return false;
  const [cuerpo, dv] = norm.split('-') as [string, string];
  return calcularDv(cuerpo) === dv;
}

export function ocultarRut(rutNormalizado: string): string {
  const [cuerpo, dv] = rutNormalizado.split('-') as [string, string];
  return `${cuerpo.slice(0, 2)}${'*'.repeat(Math.max(0, cuerpo.length - 2))}-${dv}`;
}
