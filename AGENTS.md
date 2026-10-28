# Instrucciones para agentes

Este archivo lo leen Claude Code y Codex. Léelo completo antes de tocar nada.

## Qué es esto

Un agente que **emite facturas electrónicas reales en el SII de Chile**, por el
emisor CTA CONSULTORES (RUT 77.859.563-K). Cada emisión es un **documento
tributario irreversible**: una vez emitido existe ante el SII y no se borra,
solo se anula con nota de crédito.

No es un proyecto donde "probar a ver qué pasa". A octubre de 2026 lleva
emitidos los folios 35 a 69 contra el portal real.

## Reglas que no se negocian

1. **Nunca emitir sin aprobación humana.** `emit` exige el texto exacto
   `APROBAR <factura_id>` (local) o un enlace firmado con HMAC (nube). No
   agregues rutas que salten ese paso, ni siquiera "para probar".
2. **Una sola acción de emisión, jamás reintentos automáticos.** Si el SII
   responde de forma incierta, la factura queda en `REQUIERE_REVISION` y
   **ninguna ruta automática puede volver a emitirla**. Re-emitir genera un
   documento tributario duplicado.
3. **`REQUIERE_REVISION` es estado terminal.** No le agregues transiciones de
   salida en `src/domain/maquina-estados.ts`. Si hay que recuperar una
   factura, se borra su fila y se vuelve a preparar — nunca se "arregla" el
   estado a mano.
4. **La aprobación está ligada al hash SHA-256 del payload.** Si el contenido
   cambia entre la notificación y la emisión, la aprobación se invalida. No
   relajes esa comparación.
5. **Un folio confirmado jamás se pierde.** Si falla la descarga del PDF o el
   correo después de tener folio, eso es `ERROR_REINTENTABLE`, no incierto.
6. **El SII es la fuente de verdad.** Ante cualquier duda sobre si un documento
   existe, se consulta el Registro de Compras y Ventas (RCV) del SII. No se
   infiere desde la secuencia de folios: ya falló una vez.
7. **Secretos solo en el llavero de macOS o en GitHub Secrets.** Nunca en
   código, Excel, logs ni commits. El logger redacta RUTs, correos y tokens.
8. **El agente no evade controles de seguridad.** Si el SII pide captcha o
   segundo factor, se detiene y espera al operador.

## Antes de dar por terminado cualquier cambio

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Los cuatro en verde. Son 331 pruebas y corren en ~2 segundos; no hay excusa
para saltarlas. **Las pruebas automáticas jamás tocan el SII real ni envían
correos.** Desde el 28-10-2026 CI (`.github/workflows/ci.yml`) corre esos
mismos cuatro en cada push a `main` y en cada pull request, sin secretos y
fuera del grupo `facturacion-sii`; que esté verde no reemplaza correrlos antes
de commitear, solo atrapa al que se olvidó.

### Puesta en marcha

```bash
pnpm install
```

Sin pasos manuales. `package.json` fija `packageManager: pnpm@12.14.0` (corepack
y `pnpm/action-setup` lo leen, así local y CI usan la misma versión) y
`pnpm-workspace.yaml` autoriza los scripts de build de `better-sqlite3` y
`esbuild` con `allowBuilds`. Ojo: pnpm 11+ eliminó `onlyBuiltDependencies` y
dejó de leer el campo `pnpm` de `package.json`; si vuelve a aparecer
`ERR_PNPM_IGNORED_BUILDS`, lo que se movió es esa lista, no el archivo.

## Mapa del proyecto

| Ruta | Qué vive ahí |
|---|---|
| `src/domain/` | Lógica tributaria pura: RUT módulo 11, fechas, dinero, agrupación, máquina de estados. Sin E/S. |
| `src/adapters/sii/` | Playwright contra el portal del SII. Lo más frágil del sistema. |
| `src/adapters/excel/` | Lectura del libro en OneDrive vía Microsoft Graph. |
| `src/adapters/graph/` | Cliente Graph, reintentos, cache cifrado de tokens MSAL. |
| `src/store/` | Auditoría. Tres implementaciones de `IAuditStore`: SQLite local, Supabase (respaldo) y Cloudflare D1 (actual). |
| `src/cli/` | Comandos y armado del entorno (local vs nube). |
| `cloudflare/` | Worker (`/aprobar`, `/telegram-webhook`), esquema D1 y `wrangler.toml`. |
| `docs/` | `cloudflare.md` es el modo vigente; `nube.md` describe el Supabase anterior. |

### Dónde está el estado

Desde el 15-10-2026 la nube corre en **Cloudflare**: auditoría en D1, PDFs en
R2, aprobaciones por el Worker. Se activa con `CF_API_URL` + `CF_API_TOKEN`.
Supabase quedó como plan B y solo se usa con `AGENTE_MODO=supabase` explícito.
Media credencial de cualquiera de los dos pares hace que el agente **lance**
en vez de caer a otro modo: para documentos tributarios, escribir en la fuente
de verdad equivocada sin un error es peor que no operar.

## Convenciones

- **Todo el proyecto está en español**: identificadores, comentarios, mensajes
  de commit y documentación. Mantenlo así por consistencia — no mezcles.
- Commits con prefijo: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`,
  `diag:`. El cuerpo explica **por qué**, no qué.
- Archivos chicos y cohesionados. Funciones bajo 50 líneas.
- Los comentarios explican decisiones y evidencia, no lo que el código ya dice.
  Buen ejemplo: `src/adapters/sii/vigilante-folio.ts`, que documenta el lote
  del 25-08-2026 donde 5 de 11 emisiones quedaron sin folio.
- Validación en los bordes con Zod (`src/domain/validacion.ts`). Nada de
  confiar en lo que venga del Excel.

## Trampas conocidas

- **`dia_emision` solo admite 1 a 28.** Febrero no tiene 30. Está validado en
  dos capas y es a propósito.
- **Las fechas del Excel van como texto** (`'2026-08-01` con apóstrofe). Si
  Excel las convierte a número de serie, `esquemaCobro.parse()` lanza y
  **aborta el lote completo**, no solo esa fila.
- **`prepare` solo crea facturas si la fecha pedida calza exacto con la
  programada.** Un lote atrasado no se recupera solo; hay que pasarle
  `--date AAAA-MM-DD`.
- **Emitir varias facturas en una sola corrida falla una de cada dos** (ver
  `TAREAS.md`). De a una funciona. No lo des por resuelto.

## Qué hacer si algo sale mal en una emisión

1. **No re-emitir.** Nunca, bajo ninguna circunstancia, sin verificar antes.
2. Descargar el RCV de ese mes desde el SII y buscar el RUT del receptor.
3. Si el documento **existe**: el folio hay que adoptarlo y el PDF se envía a
   mano. La factura ya está emitida.
4. Si **no existe**: se borra su fila de la auditoría y se vuelve a preparar.
5. La evidencia de cada sesión (capturas + HTML) queda como artefacto del
   workflow por 30 días, y en `.data/evidence/` cuando corre local.
