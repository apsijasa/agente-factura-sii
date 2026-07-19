// src/domain/validacion.ts
import { z } from 'zod';
import { esRutValido, normalizarRut } from './rut.js';

const VERDADEROS = new Set(['true', 'verdadero', '1', 'si', 'sí']);
const FALSOS = new Set(['false', 'falso', '0', 'no']);

export function parsearBooleano(valor: string): boolean {
  const v = valor.trim().toLowerCase();
  if (VERDADEROS.has(v)) return true;
  if (FALSOS.has(v)) return false;
  throw new Error(`Valor booleano no reconocido: "${valor}"`);
}

const RE_CORREO = /^[^\s@;]+@[^\s@;]+\.[^\s@;]+$/;

export function parsearDestinatarios(campo: string): string[] {
  const correos = campo
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (correos.length === 0) throw new Error('Se requiere al menos un correo válido');
  for (const correo of correos) {
    if (!RE_CORREO.test(correo)) throw new Error(`Correo inválido: "${correo}"`);
  }
  return correos;
}

const rutValidado = z.string().transform((v, ctx) => {
  if (!esRutValido(v)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `RUT inválido: "${v}"` });
    return z.NEVER;
  }
  return normalizarRut(v) as string;
});

const booleano = z.string().transform((v) => parsearBooleano(v));
const correo = z.string().regex(RE_CORREO, 'Correo inválido');
const fechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha debe ser AAAA-MM-DD');
const idNoVacio = z.string().trim().min(1);

export const esquemaEmpresa = z.object({
  empresa_id: idNoVacio,
  rut_emisor: rutValidado,
  razon_social: idNoVacio,
  email_remitente: correo,
  email_copia: correo,
  activo: booleano,
});

export const esquemaCliente = z.object({
  cliente_id: idNoVacio,
  razon_social: idNoVacio,
  nombre_carpeta: idNoVacio,
  rut_cliente: rutValidado,
  email_facturacion: z.string().refine((v) => {
    try { parsearDestinatarios(v); return true; } catch { return false; }
  }, 'email_facturacion debe contener correos válidos separados por ;'),
  giro: z.string(),
  direccion: z.string(),
  comuna: z.string(),
  ciudad: z.string(),
  activo: booleano,
});

export const esquemaCobro = z
  .object({
    cobro_id: idNoVacio,
    empresa_id: idNoVacio,
    cliente_id: idNoVacio,
    descripcion_servicio: idNoVacio,
    moneda: z.enum(['CLP', 'UF']),
    monto_neto: z.coerce.number().positive(),
    cantidad: z.coerce.number().positive(),
    frecuencia: z.literal('MENSUAL'),
    dia_emision: z.coerce.number().int().min(1).max(28),
    forma_pago: z.enum(['CONTADO', 'CREDITO']),
    dias_vencimiento: z.coerce.number().int().min(0),
    fecha_inicio: fechaIso,
    fecha_fin: z
      .string()
      .transform((v) => (v.trim() === '' ? null : v))
      .pipe(fechaIso.nullable()),
    activo: booleano,
  })
  .superRefine((c, ctx) => {
    if (c.forma_pago === 'CONTADO' && c.dias_vencimiento !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'CONTADO exige dias_vencimiento = 0' });
    }
    if (c.moneda === 'CLP' && !Number.isInteger(c.monto_neto)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'monto_neto CLP debe ser entero' });
    }
  });

export type EmpresaValidada = z.output<typeof esquemaEmpresa>;
export type ClienteValidado = z.output<typeof esquemaCliente>;
export type CobroValidado = z.output<typeof esquemaCobro>;
