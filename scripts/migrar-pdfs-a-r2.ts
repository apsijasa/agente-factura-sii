// scripts/migrar-pdfs-a-r2.ts
// Migración única: copia los PDFs emitidos desde Supabase Storage (bucket
// privado `facturas`) a Cloudflare R2, con la MISMA clave, vía el Worker.
// Idempotente: si un PDF ya está en R2 lo verifica en vez de reescribirlo.
// Al final compara SHA-256 de origen y destino para cada archivo.
//
// Uso (o desde Actions → "Migrar PDFs a R2"):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... CF_API_URL=... CF_API_TOKEN=... \
//     pnpm tsx scripts/migrar-pdfs-a-r2.ts
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { ApiCloudflare, ErrorApiCloudflare } from '../src/store/api-cloudflare.js';
import { PREFIJO_SUPABASE } from '../src/services/almacen-pdf.js';

function requerida(nombre: string): string {
  const v = process.env[nombre];
  if (!v) throw new Error(`Falta la variable de entorno ${nombre}`);
  return v;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function main(): Promise<void> {
  const sb = createClient(requerida('SUPABASE_URL'), requerida('SUPABASE_SERVICE_ROLE_KEY'));
  const api = new ApiCloudflare(requerida('CF_API_URL'), requerida('CF_API_TOKEN'));

  const { results } = await api.query<{ pdf_path: string }>(
    'SELECT pdf_path FROM invoice_runs WHERE pdf_path LIKE ? ORDER BY pdf_path',
    [`${PREFIJO_SUPABASE}%`],
  );
  const claves = results.map((r) => r.pdf_path.slice(PREFIJO_SUPABASE.length));
  console.log(`PDFs referenciados en la auditoría: ${claves.length}`);

  let copiados = 0;
  let yaEstaban = 0;
  const fallas: string[] = [];
  for (const clave of claves) {
    const { data, error } = await sb.storage.from('facturas').download(clave);
    if (error || !data) {
      fallas.push(`${clave}: no se pudo descargar de Supabase (${error?.message ?? 'sin datos'})`);
      continue;
    }
    const origen = Buffer.from(await data.arrayBuffer());
    try {
      await api.subirPdf(clave, origen);
      copiados++;
    } catch (e) {
      if (!(e instanceof ErrorApiCloudflare && e.codigo === 'YA_EXISTE')) {
        fallas.push(`${clave}: ${(e as Error).message}`);
        continue;
      }
      yaEstaban++;
    }
    const destino = await api.descargarPdf(clave);
    if (sha(destino) !== sha(origen)) fallas.push(`${clave}: el contenido en R2 NO coincide con Supabase`);
  }

  console.log(JSON.stringify({ total: claves.length, copiados, yaEstaban, verificados: claves.length - fallas.length, fallas }, null, 2));
  if (fallas.length > 0) process.exitCode = 1;
}

await main();
