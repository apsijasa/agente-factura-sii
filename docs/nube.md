# Modo nube — el agente sin tu computador

El agente puede correr completo en la nube: GitHub Actions ejecuta los ciclos,
la auditoría vive en Supabase (Postgres), los PDFs en un bucket privado de
Supabase Storage, y tú apruebas cada factura desde el teléfono. Tu Mac puede
estar apagado.

**La aprobación humana sigue siendo obligatoria.** Nada se emite sin que tú
abras el enlace de aprobación. Lo único que cambió es dónde apruebas: antes en
la terminal, ahora desde WhatsApp o correo.

## Arquitectura

```
GitHub Actions (cron)                      Supabase (proyecto agente-factura-sii)
┌──────────────────────────┐               ┌──────────────────────────────────┐
│ prepare-notify (diario)  │── lee Excel ──│ Postgres: invoice_runs, approvals │
│  prepare + notify        │── escribe ───▶│   state_events, invoice_lines,    │
│                          │               │   email_attempts (RLS, solo       │
│ emit-approved (cada 30m) │               │   service role)                   │
│  gate barato → emitir    │◀── lee ───────│ Storage: bucket privado facturas  │
└──────────────────────────┘               │ Edge Function: aprobar            │
        │                                  └──────────────▲───────────────────┘
        ▼                                                 │ clic en el enlace
   SII (Playwright headless)                Tu teléfono (WhatsApp o correo)
```

Ciclo completo:

1. **07:00 (Chile), todos los días** — `prepare-notify`: lee el Excel de
   OneDrive, prepara las facturas del día (`PENDIENTE_APROBACION`) y te envía
   por WhatsApp (o correo, si WhatsApp no está configurado) el resumen de cada
   una con un **enlace de aprobación firmado** (HMAC, ligado al hash exacto del
   contenido, vence en 48 h).
2. **Tú apruebas desde el teléfono** — el enlace abre la Edge Function
   `aprobar`, que valida el token y registra la aprobación. Si el Excel cambió
   después de la notificación, la aprobación se rechaza por seguridad.
3. **Cada 30 minutos (08:00–19:30 Chile)** — `emit-approved`: un chequeo barato
   pregunta a Supabase si hay facturas aprobadas pendientes. Solo si las hay,
   instala Chromium, entra al SII (headless), emite, captura el folio, sube el
   PDF al bucket y lo envía por correo al cliente. Todo queda auditado.
4. Si el SII pide captcha o verificación extra, el comando falla de forma
   segura: la factura queda en `REQUIERE_REVISION` y no se reintenta sola.
   La evidencia (capturas + HTML) queda como artefacto del workflow (30 días).

Si no aprobaste nada, no se emite nada; el recordatorio se reenvía cada mañana
mientras la factura siga pendiente.

## Configuración (una sola vez)

### 1. Secreto de aprobación

Genera un secreto largo (en tu Mac):

```bash
openssl rand -hex 32
```

Este valor va en DOS lugares con el mismo contenido:

- **Supabase** → proyecto `agente-factura-sii` → Edge Functions → Secrets →
  crear `APPROVAL_SECRET`.
- **GitHub** → repo `agente-factura-sii` → Settings → Secrets and variables →
  Actions → `APPROVAL_SECRET`.

### 2. Azure (Microsoft Entra) — ejecución desatendida

La app actual usa "device code" (interactivo). Para la nube se necesita
**client credentials**:

1. [portal.azure.com](https://portal.azure.com) → Microsoft Entra ID → App
   registrations → tu aplicación (la del `clientId` de `.data/config.json`).
2. **Certificates & secrets** → New client secret → copia el valor (se muestra
   una sola vez). Ese valor es el GitHub Secret `GRAPH_CLIENT_SECRET`.
3. **API permissions** → Add a permission → Microsoft Graph →
   **Application permissions** → agregar `Files.ReadWrite.All` y `Mail.Send` →
   botón **Grant admin consent**.
4. (Opcional, recomendado) Restringir `Mail.Send` al buzón con una
   [ApplicationAccessPolicy](https://learn.microsoft.com/en-us/graph/auth-limit-mailbox-access)
   de Exchange Online.

### 3. Canal de notificación (opcional — sin nada de esto, los avisos llegan por correo)

El orden de preferencia es **Telegram → WhatsApp → correo**, según qué secretos
existan.

**Telegram (recomendado para partir — 5 minutos, gratis, sin aprobaciones):**

1. En Telegram, habla con **@BotFather** → `/newbot` → dale un nombre y un
   usuario (ej. `atlas_facturas_bot`). BotFather te entrega el **token**
   (formato `123456:ABC-...`).
2. Escríbele cualquier mensaje a tu bot recién creado (ej. "hola") — esto es
   obligatorio: un bot no puede iniciar conversación contigo.
3. Abre en el navegador
   `https://api.telegram.org/bot<TU_TOKEN>/getUpdates` y busca
   `"chat":{"id":XXXXXXXXX` — ese número es tu **chat id**.
4. GitHub Secrets: `TELEGRAM_BOT_TOKEN` (paso 1) y `TELEGRAM_CHAT_ID` (paso 3).
5. Probar: Actions → **"Probar canal de notificaciones"** → Run workflow →
   te debe llegar un mensaje `[PRUEBA]` del bot.

**WhatsApp (Cloud API oficial de Meta):**

1. [developers.facebook.com](https://developers.facebook.com) → crear app de
   tipo Business → producto **WhatsApp**.
2. De la pantalla "API Setup" copiar: **token permanente** (crear un system
   user con permiso whatsapp_business_messaging), **Phone number ID**, y
   registrar tu número personal como destinatario de prueba.
3. GitHub Secrets: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_TO`
   (tu número con código de país, ej. `569XXXXXXXX`).
4. Nota: los mensajes de texto libre solo llegan dentro de las 24 h siguientes
   a tu último mensaje al número del bot; para avisos mensuales se necesita
   una plantilla de utilidad aprobada (ajuste pendiente si se adopta este canal).

### 4. GitHub Secrets (lista completa)

En el repo → Settings → Secrets and variables → Actions:

| Secreto | Valor |
|---|---|
| `AGENTE_CONFIG_JSON` | El contenido completo de tu `.data/config.json` local (`cat .data/config.json \| pbcopy`) |
| `SUPABASE_URL` | `https://ivhvatrfqkrrmnkdjctn.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API keys → `service_role` |
| `GRAPH_CLIENT_SECRET` | El client secret de Azure (paso 2) |
| `SII_CLAVE` | La clave del SII de la empresa (la misma del llavero) |
| `SII_CLAVE_FIRMA` | La clave de firma del DTE (la misma del llavero) |
| `APPROVAL_SECRET` | El secreto del paso 1 |
| `APPROVAL_URL` | `https://ivhvatrfqkrrmnkdjctn.supabase.co/functions/v1/aprobar` |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Paso 3, opción Telegram (opcionales) |
| `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_ID` / `WHATSAPP_TO` | Paso 3, opción WhatsApp (opcionales) |

Mientras falten los secretos, los workflows terminan sin hacer nada (sin
errores ruidosos).

### 5. Probar

1. GitHub → Actions → "Preparar y notificar" → **Run workflow**. Si hay cobros
   para hoy, te llegará la notificación con el enlace.
2. Abre el enlace y aprueba.
3. Actions → "Emitir aprobadas" → **Run workflow** (o espera al próximo ciclo
   de 30 min). Revisa el resumen del run y el PDF en el bucket.

## Cómo se decide el modo (local vs nube)

El mismo código sirve para ambos; el modo se activa por variables de entorno:

| Variable | Efecto |
|---|---|
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Auditoría en Postgres y PDFs en el bucket (en vez de SQLite y `cliente/`) |
| `AGENTE_CONFIG_JSON` | Configuración desde el entorno (en vez de `.data/config.json`) |
| `GRAPH_CLIENT_SECRET` | Graph con client credentials (en vez de device code) |
| `SII_CLAVE` / `SII_CLAVE_FIRMA` | Claves desde el entorno (en vez del llavero de macOS) |
| `SII_HEADLESS=1` | Navegador del SII sin ventana |

Sin esas variables, todo funciona igual que siempre en tu Mac (SQLite local,
llavero, navegador visible, aprobación por terminal con `APROBAR <id>`).

## Comandos nuevos

| Comando | Efecto |
|---|---|
| `pnpm agent notify` | Envía la solicitud de aprobación remota de cada `PENDIENTE_APROBACION` sin aprobación vigente |
| `pnpm agent emit-approved` | Emite únicamente las facturas con aprobación remota que coincide con el hash actual |

## Seguridad en la nube

- **RLS activo sin políticas**: solo el service role (los workflows y la Edge
  Function) puede leer o escribir; las llaves públicas de Supabase no ven nada.
- **El enlace de aprobación** está firmado (HMAC-SHA256), vence en 48 h, va
  ligado a UNA factura y a UN contenido exacto; si el Excel cambia, no sirve.
- **Atomicidad servidor**: crear factura y transicionar estado son funciones
  RPC de Postgres con compare-and-swap — mismas garantías que el SQLite local.
- **Bucket privado con `upsert:false`**: un PDF de folio confirmado jamás se
  sobrescribe.
- **Los secretos** viven en GitHub Secrets y en los secrets de Supabase, nunca
  en el código ni en la base.
- **Captcha/MFA jamás se evaden**: sin operador presente, la factura queda en
  `REQUIERE_REVISION` y te enteras por el run fallido + el estado en Excel.

## Datos migrados

La auditoría histórica local (folios 35 y 36, las dos canceladas de julio, sus
eventos, aprobaciones e intentos de correo) ya fue copiada a Supabase el
25-07-2026. El SQLite local sigue existiendo y sigue siendo válido para el modo
local, pero desde la migración **la nube es la fuente de verdad** si operas con
los workflows.

## Consumo de minutos de Actions (repo privado)

- `prepare-notify`: 1 run diario ≈ 2 min → ~60 min/mes.
- `emit-approved`: 24 runs diarios, casi todos solo el gate (<1 min) → ~700
  min/mes en el peor caso.

El plan gratuito de GitHub incluye 2.000 min/mes; el margen es holgado. Si
quieres reducirlo, baja la frecuencia del cron de `emit-approved`.
