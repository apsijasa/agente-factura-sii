# Modo nube en Cloudflare (reemplaza a Supabase)

Desde el 15-10-2026 el modo nube corre en Cloudflare en vez de Supabase. El
flujo es el mismo de [nube.md](nube.md) (GitHub Actions + aprobación desde el
teléfono). Lo único que cambia es dónde viven los datos:

| Antes (Supabase) | Ahora (Cloudflare) |
|---|---|
| Postgres (6 tablas + vista `facturas_aprobadas_pendientes`) | **D1** `agente-factura-sii` (mismo esquema en SQLite: `cloudflare/migrations/0001_esquema_auditoria.sql`) |
| RPC `crear_factura` / `registrar_transicion` | Endpoints del Worker `/api/crear-factura` y `/api/registrar-transicion` (batch atómico con el mismo compare-and-swap) |
| Edge Function `aprobar` | Worker `GET /aprobar` |
| Edge Function `telegram-webhook` | Worker `POST /telegram-webhook` |
| Storage, bucket privado `facturas` | **R2** `agente-factura-sii-facturas` (mismas claves; PUT nunca sobrescribe) |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | `CF_API_URL` + `CF_API_TOKEN` |

El agente nunca toca D1/R2 directamente: habla con la API privada del Worker
(`/api/*`, protegida con `Authorization: Bearer AGENT_API_TOKEN`). Solo el
Worker tiene acceso a la base y al bucket.

**Datos ya migrados:** las 6 tablas se copiaron a D1 el 15-10-2026 (25
facturas, 29 líneas, 163 eventos, 23 aprobaciones, 24 intentos de correo) y se
verificaron con un checksum idéntico al de Supabase. Los `pdf_path` históricos
`supabase://facturas/...` se dejan tal cual: el almacén R2 los lee con la misma
clave.

## Puesta en marcha (una sola vez)

### 1. Activar R2

Cloudflare Dashboard → **R2 Object Storage** → *Get started* / *Purchase R2
Plan* (el plan gratuito incluye 10 GB; pide medio de pago aunque no cobre).
Después crear el bucket:

```bash
cd cloudflare
npm install
npx wrangler login
npx wrangler r2 bucket create agente-factura-sii-facturas
```

### 2. Desplegar el Worker

```bash
npx wrangler deploy
```

Anota la URL que imprime, del tipo
`https://agente-factura-sii.<tu-subdominio>.workers.dev`.

### 3. Secretos del Worker

```bash
openssl rand -hex 32      # → AGENT_API_TOKEN (nuevo)
npx wrangler secret put AGENT_API_TOKEN
npx wrangler secret put APPROVAL_SECRET          # el MISMO valor que ya está en GitHub
npx wrangler secret put TELEGRAM_BOT_TOKEN       # el mismo del bot
npx wrangler secret put TELEGRAM_CHAT_ID         # el mismo chat id
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET  # el mismo (o uno nuevo con openssl rand -hex 16)
```

### 4. GitHub Secrets

Repo → Settings → Secrets and variables → Actions:

| Secreto | Valor |
|---|---|
| `CF_API_URL` | La URL del paso 2 (sin `/` final) |
| `CF_API_TOKEN` | El `AGENT_API_TOKEN` del paso 3 |
| `APPROVAL_URL` | **Cambiar** a `<CF_API_URL>/aprobar` |

Los secretos `SUPABASE_*` se mantienen solo hasta terminar el paso 5.

### 5. Copiar los PDFs a R2

Actions → **"Migrar PDFs a R2"** → *Run workflow*. Copia los 20 PDFs del bucket
de Supabase a R2 y verifica el SHA-256 de cada uno. Debe terminar con
`"fallas": []`. Es idempotente: se puede repetir.

### 6. Re-apuntar el bot de Telegram

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<CF_API_URL>/telegram-webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

### 7. Probar

1. `curl -H "Authorization: Bearer <CF_API_TOKEN>" <CF_API_URL>/api/gate/aprobadas-pendientes` → `[]`.
2. Actions → "Emitir aprobadas" → *Run workflow*: el gate debe responder `[]` y terminar sin emitir.
3. Escribirle `/ayuda` al bot: debe contestar con la ayuda.

### 8. Apagar Supabase

Cuando el ciclo del día 25 haya funcionado en Cloudflare:

- Borrar los secretos `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` de GitHub.
- Pausar o eliminar el proyecto `agente-factura-sii` en Supabase.

## Importante: hacer el corte antes del próximo ciclo

D1 tiene una copia de Supabase tomada el 15-10-2026. Los workflows que hoy
están en GitHub siguen usando Supabase hasta que subas estos cambios
(`git push`); desde ese momento, y mientras falten los secretos `CF_*`, no
hacen nada (terminan en el chequeo de configuración). Haz el corte completo
(pasos 1–7) antes del ciclo del 25. Si algo alcanzó a escribirse en Supabase
después del 15-10 (otra factura, una aprobación, un `/factura`), hay que
volver a copiar esas filas a D1 antes de operar en Cloudflare.

## Volver a Supabase (plan B)

El código de Supabase sigue en el repo. Si no existen `CF_API_URL`/`CF_API_TOKEN`
y sí `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, el agente usa Supabase como
antes (ver `esNubeCloudflare` / `esNubeSupabase` en `src/cli/entorno.ts`).
Para eso también hay que revertir los gates de los workflows.

## Costos

Con el volumen actual (unas 10 facturas al mes) todo cabe en los planes
gratuitos: Workers (100.000 solicitudes/día), D1 (5 GB y 5 millones de
lecturas/día) y R2 (10 GB). La diferencia práctica con Supabase Free es que
**D1 no se pausa por inactividad**.
