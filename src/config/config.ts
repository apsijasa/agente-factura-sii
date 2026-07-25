// src/config/config.ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { esRutValido } from '../domain/rut.js';

export const esquemaConfig = z.object({
  tenantId: z.string().min(1),
  clientId: z.string().min(1),
  buzonPrincipal: z.string().email(),
  driveId: z.string().min(1),
  itemId: z.string().min(1),
  rutaRaizClientes: z.string().min(1),
  rutaDatos: z.string().min(1).default('.data'),
  timeoutSiiMs: z.number().int().positive().default(120000),
  timeoutAprobacionMs: z.number().int().positive().default(300000),
  modoPredeterminado: z.literal('simulation'),
  // RUT de la persona natural (dueño/rep. legal) con el que se inicia sesión en
  // el SII. Si está presente, el agente completa el login con la clave del
  // llavero; si falta, el login es manual en la ventana visible.
  rutOperador: z
    .string()
    .refine((v) => esRutValido(v), 'rutOperador debe ser un RUT válido')
    .optional(),
  emisores: z
    .record(
      z.object({
        tipoVenta: z.string().min(1),
        tipoCompra: z.string().min(1),
        // El formulario del SII exige la ciudad del emisor y no siempre la
        // precarga desde el padrón; se completa desde aquí si falta.
        ciudadEmisor: z.string().optional(),
      }),
    )
    .refine((e) => Object.keys(e).length > 0, 'Debe configurarse al menos un emisor'),
});

export type Config = z.output<typeof esquemaConfig>;

export async function cargarConfig(raizProyecto: string): Promise<Config> {
  // Modo nube (GitHub Actions): la configuración completa llega por entorno
  // como secreto del repositorio, sin archivo en disco.
  const desdeEntorno = process.env.AGENTE_CONFIG_JSON;
  if (desdeEntorno) {
    return esquemaConfig.parse(JSON.parse(desdeEntorno));
  }
  const ruta = join(raizProyecto, '.data', 'config.json');
  let crudo: string;
  try {
    crudo = await readFile(ruta, 'utf8');
  } catch {
    throw new Error(`No existe ${ruta}. Ejecute: pnpm agent setup`);
  }
  return esquemaConfig.parse(JSON.parse(crudo));
}
