// src/domain/dinero.ts
import { Decimal } from 'decimal.js';

const D = Decimal.clone({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export interface LineaCalculada {
  precioUnitarioClp: number;
  totalLineaClp: number;
}

export function redondearHalfUp(valor: Decimal.Value): number {
  return new D(valor).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

export function lineaClp(montoNeto: number, cantidad: number): LineaCalculada {
  if (!Number.isInteger(montoNeto) || montoNeto <= 0) {
    throw new Error(`monto_neto CLP debe ser un entero positivo, recibido: ${montoNeto}`);
  }
  validarCantidad(cantidad);
  return { precioUnitarioClp: montoNeto, totalLineaClp: redondearHalfUp(new D(montoNeto).mul(cantidad)) };
}

export function lineaUf(montoNetoUf: number, cantidad: number, valorUf: number): LineaCalculada {
  if (montoNetoUf <= 0) throw new Error(`monto_neto UF debe ser positivo, recibido: ${montoNetoUf}`);
  if (valorUf <= 0) throw new Error(`valor_uf debe ser positivo, recibido: ${valorUf}`);
  validarCantidad(cantidad);
  const precioUnitarioClp = redondearHalfUp(new D(montoNetoUf).mul(valorUf));
  return { precioUnitarioClp, totalLineaClp: redondearHalfUp(new D(precioUnitarioClp).mul(cantidad)) };
}

export function totalesEsperados(totalesLinea: number[]): { netoClp: number; ivaClp: number; totalClp: number } {
  if (totalesLinea.length === 0) throw new Error('No hay líneas para totalizar');
  const netoClp = totalesLinea.reduce((a, b) => a + b, 0);
  const ivaClp = redondearHalfUp(new D(netoClp).mul('0.19'));
  return { netoClp, ivaClp, totalClp: netoClp + ivaClp };
}

function validarCantidad(cantidad: number): void {
  if (!(cantidad > 0)) throw new Error(`cantidad debe ser positiva, recibido: ${cantidad}`);
}
