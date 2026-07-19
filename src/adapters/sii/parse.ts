// src/adapters/sii/parse.ts
export { parseMontoChileno } from '../uf/uf-provider.js';

export interface TotalesSii {
  netoClp: number;
  ivaClp: number;
  totalClp: number;
}

export function compararTotales(
  esperado: TotalesSii,
  mostrado: TotalesSii,
): { coinciden: boolean; diferencias: string[] } {
  const diferencias: string[] = [];
  const campos: [string, number, number][] = [
    ['neto', esperado.netoClp, mostrado.netoClp],
    ['iva', esperado.ivaClp, mostrado.ivaClp],
    ['total', esperado.totalClp, mostrado.totalClp],
  ];
  for (const [nombre, esp, real] of campos) {
    if (esp !== real) diferencias.push(`${nombre}: esperado ${esp}, SII muestra ${real}`);
  }
  return { coinciden: diferencias.length === 0, diferencias };
}
