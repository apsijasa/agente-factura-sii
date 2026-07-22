// src/cli/index.ts
import { Command } from 'commander';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { userInfo } from 'node:os';
import { cargarConfig } from '../config/config.js';
import { leerSecretoKeychain, obtenerOCrearClaveCifrado } from '../config/keychain.js';
import { crearCachePluginCifrado } from '../adapters/graph/token-cache.js';
import { normalizarRut } from '../domain/rut.js';
import { preflight } from '../config/preflight.js';
import { crearAutenticadorDeviceCode, GraphClient } from '../adapters/graph/graph-client.js';
import { ExcelAdapter } from '../adapters/excel/excel-adapter.js';
import { UfProvider } from '../adapters/uf/uf-provider.js';
import { SiiAdapterPlaywright } from '../adapters/sii/sii-adapter.js';
import { MailService } from '../services/correo.js';
import { ApprovalService } from '../services/aprobacion.js';
import { AuditStore } from '../store/audit-store.js';
import { FacturasRepository } from '../store/facturas-repository.js';
import { conBloqueo } from './lock.js';
import {
  ejecutarEmit, ejecutarPrepare, ejecutarPreviewSii, ejecutarRetryEmail, type Dependencias,
} from './comandos.js';
import { logger } from '../services/logger.js';

const RAIZ = process.cwd();

// Cache de tokens Microsoft cifrado (la llave vive en el llavero): evita
// repetir el código de dispositivo en cada comando.
function cachePluginMsal(rutaDatos: string) {
  return crearCachePluginCifrado(join(rutaDatos, 'msal-cache.enc'), () => obtenerOCrearClaveCifrado());
}

type Readline = ReturnType<typeof createInterface>;

async function armarDependencias(): Promise<{ deps: Dependencias; repo: FacturasRepository; rutEmisor: string; graph: GraphClient; rutaDatos: string; rl: Readline }> {
  const config = await cargarConfig(RAIZ);
  const rutaDatos = join(RAIZ, config.rutaDatos);
  const graph = new GraphClient(
    crearAutenticadorDeviceCode({ ...config, cachePlugin: cachePluginMsal(rutaDatos) }),
  );
  const excel = new ExcelAdapter(graph, config);
  const store = new AuditStore(join(rutaDatos, 'agente.sqlite'));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const io = {
    pregunta: (mensaje: string) =>
      Promise.race([
        rl.question(mensaje),
        new Promise<string>((_, rechazar) =>
          setTimeout(() => rechazar(new Error('Aprobación expirada')), config.timeoutAprobacionMs),
        ),
      ]),
  };
  const deps: Dependencias = {
    store,
    excel,
    uf: new UfProvider(),
    sii: new SiiAdapterPlaywright({
      dirEvidencia: join(rutaDatos, 'evidence'),
      timeoutMs: config.timeoutSiiMs,
      ciudadEmisor: Object.values(config.emisores)[0]?.ciudadEmisor,
      rutOperador: config.rutOperador ? (normalizarRut(config.rutOperador) ?? undefined) : undefined,
      leerSecreto: () => leerSecretoKeychain(Object.keys(config.emisores)[0] as string),
    }),
    correo: new MailService(graph, config.buzonPrincipal),
    aprobacion: new ApprovalService(io, () => new Date(), userInfo().username),
    clasificaciones: config.emisores,
    rutaRaizClientes: config.rutaRaizClientes,
    hoy: () => new Date().toISOString().slice(0, 10),
  };
  const primerEmisor = Object.keys(config.emisores)[0] as string;
  return { deps, repo: new FacturasRepository(store, excel), rutEmisor: primerEmisor, graph, rutaDatos, rl };
}

async function conEntorno(verificarGraph: boolean, fn: (deps: Dependencias, repo: FacturasRepository) => Promise<void>): Promise<void> {
  const config = await cargarConfig(RAIZ);
  const { deps, repo, rutEmisor, graph, rutaDatos, rl } = await armarDependencias();
  try {
    await conBloqueo(rutaDatos, async () => {
      const chequeo = await preflight(config, graph, rutEmisor, { verificarGraph });
      if (!chequeo.ok) {
        throw new Error(`Preflight falló:\n- ${chequeo.fallas.join('\n- ')}`);
      }
      await repo.reconciliar();
      // Recuperación: filas huérfanas en EMITIENDO (proceso caído en plena
      // emisión) pasan a REQUIERE_REVISION antes de permitir cualquier acción.
      const interrumpidas = deps.store.marcarEmisionesInterrumpidas();
      for (const facturaId of interrumpidas) {
        logger.warn(`Emisión interrumpida detectada: ${facturaId}; marcada REQUIERE_REVISION`);
        await repo.reflejar(facturaId, {
          estado: 'REQUIERE_REVISION',
          error:
            'emisión interrumpida por caída del proceso; verificar documentos emitidos en el SII antes de cualquier acción',
        });
      }
      try {
        await fn(deps, repo);
      } finally {
        await deps.sii.cerrar();
        deps.store.cerrar();
      }
    });
  } finally {
    // Sin este cierre, readline mantiene vivo el proceso tras cada comando.
    rl.close();
  }
}

const programa = new Command('agente-factura-sii');
programa.description('Agente local de facturación SII (modo predeterminado: simulacion)');

programa
  .command('prepare')
  .option('--mode <modo>', 'simulation (único modo de prepare)', 'simulation')
  .option('--date <fecha>', 'fecha AAAA-MM-DD (por defecto: hoy)')
  .action(async (opciones: { mode: string; date?: string }) => {
    if (opciones.mode !== 'simulation') throw new Error('prepare solo admite --mode simulation');
    await conEntorno(true, async (deps) => {
      const r = await ejecutarPrepare(deps, opciones.date);
      console.log(JSON.stringify(r, null, 2));
    });
  });

programa
  .command('preview-sii')
  .requiredOption('--invoice <factura_id>')
  .action(async (opciones: { invoice: string }) => {
    await conEntorno(true, (deps) => ejecutarPreviewSii(deps, opciones.invoice));
  });

programa
  .command('emit')
  .requiredOption('--invoice <factura_id>')
  .action(async (opciones: { invoice: string }) => {
    await conEntorno(true, (deps) => ejecutarEmit(deps, opciones.invoice));
  });

programa
  .command('retry-email')
  .requiredOption('--invoice <factura_id>')
  .action(async (opciones: { invoice: string }) => {
    await conEntorno(true, (deps) => ejecutarRetryEmail(deps, opciones.invoice));
  });

programa
  .command('test-email')
  .description('Validación controlada: envía un correo [PRUEBA] desde el alias al buzón principal (no toca facturas ni el SII)')
  .action(async () => {
    const config = await cargarConfig(RAIZ);
    const graph = new GraphClient(
      crearAutenticadorDeviceCode({ ...config, cachePlugin: cachePluginMsal(join(RAIZ, config.rutaDatos)) }),
    );
    const excel = new ExcelAdapter(graph, config);
    const { esquemaEmpresa } = await import('../domain/validacion.js');
    const empresas = (await excel.leerTabla('tblEmpresas')).map((f) => esquemaEmpresa.parse(f));
    const empresa = empresas.find((e) => e.activo);
    if (!empresa) throw new Error('No hay empresa activa en tblEmpresas');
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'prueba-correo-'));
    const rutaPdf = join(dir, 'documento-de-prueba.pdf');
    await writeFile(
      rutaPdf,
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF\n',
    );
    const correo = new MailService(graph, config.buzonPrincipal);
    await correo.enviarFactura({
      remitente: empresa.email_remitente,
      destinatarios: [config.buzonPrincipal],
      copia: [],
      asunto: '[PRUEBA] Agente de facturación SII — verificación de alias',
      cuerpo:
        'Correo de prueba de la validación controlada.\n' +
        `Remitente esperado (alias): ${empresa.email_remitente}\n` +
        'Si el remitente visible en su bandeja NO es ese alias, Exchange lo está reescribiendo ' +
        'y se debe habilitar el envío desde alias antes de operar.',
      rutaPdf,
    });
    console.log(
      `Correo [PRUEBA] enviado a ${config.buzonPrincipal}. ` +
        `Revise la bandeja y verifique que el remitente visible sea ${empresa.email_remitente}.`,
    );
  });

programa
  .command('setup')
  .description('Asistente interactivo: crea .data/config.json (pide el enlace del libro sin dejarlo en argumentos)')
  .action(async () => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const tenantId = await rl.question('Tenant ID de Microsoft Entra: ');
      const clientId = await rl.question('Client ID de la aplicación: ');
      const buzonPrincipal = await rl.question('Buzón principal (autenticación): ');
      const enlace = await rl.question('Pegue el enlace compartido del libro de OneDrive: ');
      const graph = new GraphClient(
      crearAutenticadorDeviceCode({ tenantId, clientId, cachePlugin: cachePluginMsal(join(RAIZ, '.data')) }),
    );
      // Resolver driveId/itemId desde el enlace compartido (Graph shares API).
      const codificado = 'u!' + Buffer.from(enlace).toString('base64url');
      let item: { id: string; parentReference: { driveId: string } };
      try {
        item = await graph.solicitar<{ id: string; parentReference: { driveId: string } }>(
          'GET', `/shares/${codificado}/driveItem`,
        );
      } catch {
        // Sin la ruta codificada ni el mensaje original: el enlace compartido
        // es un secreto de facto y no debe filtrarse a logs ni a la terminal.
        throw new Error('No se pudo resolver el enlace compartido de OneDrive (verifique el enlace y los permisos)');
      }
      const empresaId = await rl.question('empresa_id del emisor: ');
      const tipoVenta = await rl.question('Tipo de venta SII para este emisor: ');
      const tipoCompra = await rl.question('Tipo de compra SII para este emisor: ');
      const rutaRaizClientes = join(RAIZ, 'cliente');
      const config = {
        tenantId, clientId, buzonPrincipal,
        driveId: item.parentReference.driveId, itemId: item.id,
        rutaRaizClientes, rutaDatos: '.data',
        timeoutSiiMs: 120000, timeoutAprobacionMs: 300000,
        modoPredeterminado: 'simulation',
        emisores: { [empresaId]: { tipoVenta, tipoCompra } },
      };
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(join(RAIZ, '.data'), { recursive: true });
      await writeFile(join(RAIZ, '.data', 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
      console.log('Configuración guardada en .data/config.json (fuera de Git).');
    } finally {
      rl.close();
    }
  });

programa.parseAsync(process.argv).catch((error: Error) => {
  // La ruta string ya pasa por redactarTexto vía el hook de logger; no se
  // pasa el objeto Error completo aquí (ver deviación de logger.ts).
  logger.error(error.message);
  process.exitCode = 1;
});
