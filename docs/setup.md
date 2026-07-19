# Configuración inicial

## 1. Aplicación Microsoft Entra

1. En https://entra.microsoft.com → App registrations → New registration.
2. Nombre: `agente-factura-sii`. Cuentas: solo este directorio.
3. En Authentication → Advanced settings → habilitar **Allow public client flows** (device code).
4. En API permissions añadir permisos *delegados* de Microsoft Graph:
   `User.Read`, `Files.ReadWrite`, `Mail.Send`, `offline_access`. Conceder consentimiento.
5. Anotar **Tenant ID** y **Client ID** para `pnpm agent setup`.

## 2. Credencial SII en el llavero

```bash
security add-generic-password -s agente-factura-sii -a <empresa_id> -w
```

Ingresar la clave tributaria cuando la pida (no queda en el historial).
Rotar la contraseña compartida durante el levantamiento ANTES de cualquier prueba real.

## 3. Certificado digital

Instalar el certificado digital del emisor en el llavero de macOS e importarlo en el
navegador que abre Playwright la primera vez que el SII lo solicite.

## 4. Libro de OneDrive

El libro debe contener las tablas `tblEmpresas`, `tblClientes`,
`tblCobrosRecurrentes` y `tblFacturas` con los encabezados exactos del diseño.
`pnpm agent setup` pide el enlace compartido de forma interactiva y lo resuelve
a `driveId`/`itemId` sin dejarlo en argumentos ni en Git.

## 5. Alias de correo

El buzón principal debe tener el alias (`email_remitente` de `tblEmpresas`)
habilitado para "Send from alias" en Exchange Online
(`Set-OrganizationConfig -SendFromAliasEnabled $true`). La validación práctica
del alias se hace con la prueba de correo `[PRUEBA]` (paso 3 de la validación
controlada); si el alias es reescrito, la factura queda en `DESCARGADA`.

## 6. Primera ejecución

```bash
pnpm install
pnpm exec playwright install chromium
pnpm agent setup
pnpm agent prepare --mode simulation --date 2026-07-05
```

**Nota sobre `better-sqlite3` en Node ≥ 24:** el binario prebuilt de
`better-sqlite3` puede no estar disponible para versiones recientes de Node
(no hay binario publicado para ese runtime todavía). `package.json` ya
declara `better-sqlite3` en `pnpm.onlyBuiltDependencies`, así que `pnpm
install` intenta compilarlo localmente durante el postinstall. Si la
importación de `better-sqlite3` falla (por ejemplo con `Cannot find module
'.../better_sqlite3.node'` o un error de compilación), ejecutar:

```bash
pnpm rebuild better-sqlite3
```

Esto requiere las Xcode Command Line Tools instaladas
(`xcode-select --install`), ya que la compilación usa `node-gyp` con el
toolchain de Xcode.

## 7. Validación controlada (una sola vez)

1. `prepare` en simulación con datos reales del libro.
2. `preview-sii` real sin emitir; verificar y ajustar `src/adapters/sii/selectores.ts`
   y el parser UF contra las páginas reales.
3. Prueba de correo redirigida al buzón principal con asunto `[PRUEBA]`.
4. Una única emisión real con `emit`, seleccionada y aprobada por el usuario.
5. Revisar folio, PDF en `cliente/<carpeta>/<AAAA>/<MM>/`, correo, SQLite y Excel.
