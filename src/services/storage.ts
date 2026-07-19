// src/services/storage.ts
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export function sanitizarNombreCarpeta(nombre: string): string {
  const limpio = nombre
    .replace(/[/\\\0-\x1f]/g, '')
    .replace(/\.+/g, (m, offset: number) => (offset === 0 ? '' : m))
    .replace(/^\.+|\.+$/g, '')
    .trim();
  if (limpio.length === 0) throw new Error(`nombre_carpeta inválido tras sanear: "${nombre}"`);
  return limpio;
}

export function rutaFactura(
  raiz: string,
  nombreCarpeta: string,
  fechaEmision: string,
  folio: string,
  cliente: string,
): string {
  const carpeta = sanitizarNombreCarpeta(nombreCarpeta);
  const [anio, mes] = [fechaEmision.slice(0, 4), fechaEmision.slice(5, 7)];
  const periodo = `${anio}-${mes}`;
  const nombre = `Factura_${folio}_${sanitizarNombreCarpeta(cliente)}_${periodo}.pdf`;
  const ruta = resolve(join(raiz, carpeta, anio, mes, nombre));
  const raizResuelta = resolve(raiz);
  if (!ruta.startsWith(raizResuelta + sep)) {
    throw new Error(`Ruta fuera de la raíz autorizada: ${ruta}`);
  }
  return ruta;
}

export async function guardarPdf(destino: string, datos: Buffer): Promise<void> {
  if (datos.length === 0) throw new Error('El PDF descargado está vacío');
  if (!datos.subarray(0, 5).toString('latin1').startsWith('%PDF')) {
    throw new Error('El contenido descargado no es un PDF');
  }
  await mkdir(dirname(destino), { recursive: true });
  const temporal = `${destino}.tmp-${process.pid}`;
  await writeFile(temporal, datos);
  const info = await stat(temporal);
  if (info.size !== datos.length || info.size === 0) {
    throw new Error('Verificación de tamaño del PDF falló');
  }
  await rename(temporal, destino);
}
