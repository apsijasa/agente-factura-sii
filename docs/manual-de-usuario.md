# Manual de Usuario — Agente de Facturación SII

Guía completa, paso a paso, para configurar y usar el agente. No requiere
conocimientos técnicos: cada paso indica qué escribir y qué esperar.

**Qué es**: un programa que corre en tu Mac y emite las facturas electrónicas
mensuales de tu empresa en el SII, leyendo los cobros desde un Excel en
OneDrive. Hace todo solo — entrar al SII, llenar la factura, firmarla,
descargar el PDF y enviarlo por correo — **excepto una cosa**: la aprobación
final siempre es tuya.

---

## Parte 1 — Configuración inicial (una sola vez)

### Requisitos previos

| Necesitas | Detalle |
|---|---|
| Mac | macOS con Terminal |
| Node.js y pnpm | Instalados (el proyecto ya los usa) |
| Cuenta Microsoft 365 | La del trabajo (ej: `apsijas@grupoatlas.cl`) |
| Clave del SII | La clave tributaria de la persona natural (dueño/rep. legal) |
| Clave de firma | La clave que pide el SII al firmar documentos electrónicos |
| Excel en OneDrive | El libro con las 4 tablas (ver Parte 2) |

### Paso 1. Registrar la aplicación en Microsoft Entra

1. Entra a https://entra.microsoft.com con tu cuenta de administrador.
2. **Entra ID → Registros de aplicaciones → Nueva aplicación**.
3. Nombre: `agente-factura-sii` · Cuentas: **Solo inquilino único** · Sin URI
   de redirección → **Registrar**.
4. En la página de la app, copia el **Id. de aplicación (cliente)** y el
   **Id. de directorio (inquilino)** — los pedirá el paso 5.
5. **Authentication → Configuración**: activar **"Permitir flujos de clientes
   públicos"** → Guardar.
6. **Permisos de API → Agregar un permiso → Microsoft Graph → Delegados**:
   marcar `User.Read`, `Files.ReadWrite`, `Mail.Send`, `offline_access` →
   Agregar → **"Conceder consentimiento de administrador"** (todos con check
   verde).

### Paso 2. Guardar las claves en el llavero del Mac

Abre Terminal (`Cmd + espacio` → "Terminal") y ejecuta estos dos comandos. Cada
uno pide la clave dos veces; **no se ve nada mientras escribes** (es normal):

```bash
# Clave tributaria del SII (con la que entras a sii.cl):
security add-generic-password -s agente-factura-sii -a EMP-001 -w
```

```bash
# Clave de firma del documento electrónico:
security add-generic-password -s agente-factura-sii -a EMP-001-firma -w
```

> `EMP-001` es el código de tu empresa emisora — debe ser **idéntico** al de la
> columna `empresa_id` del Excel. Las claves quedan cifradas por macOS y nunca
> se escriben en archivos.

### Paso 3. Instalar el navegador del agente

```bash
cd "/Users/andrespsijas/Documents/Codex/agente factura sii"
pnpm install
pnpm exec playwright install chromium
```

### Paso 4. Preparar el Excel en OneDrive

El libro debe tener 4 tablas con estos nombres exactos: `tblEmpresas`,
`tblClientes`, `tblCobrosRecurrentes` y `tblFacturas` (ver formatos en la
Parte 2). Cópiale el **enlace para compartir** (botón Compartir → Copiar
vínculo) — lo pedirá el paso siguiente.

### Paso 5. Asistente de configuración

```bash
pnpm agent setup
```

Responde cada pregunta:

| Pregunta | Respuesta |
|---|---|
| Tenant ID | El Id. de directorio del Paso 1 |
| Client ID | El Id. de aplicación del Paso 1 |
| Buzón principal | Tu correo Microsoft (ej `apsijas@grupoatlas.cl`) |
| Enlace del libro | Pega el enlace de OneDrive del Paso 4 |
| empresa_id | `EMP-001` |
| Tipo de venta SII | `Del Giro` (si facturas tu actividad habitual) |
| Tipo de compra SII | `Del Giro` |

Durante el asistente aparecerá un mensaje de Microsoft: abre
**https://microsoft.com/devicelogin** en tu navegador, escribe el código que
muestra la Terminal y entra con tu cuenta. **Solo se pide la primera vez** —
después la sesión queda guardada cifrada.

### Paso 6. Activar la autonomía completa (recomendado)

Abre el archivo `.data/config.json` (dentro de la carpeta del proyecto) y
agrega estas líneas dentro del bloque correspondiente:

```json
"rutOperador": "TU-RUT-CON-GUION",
```

y en `"emisores"`, dentro de `"EMP-001"`:

```json
"ciudadEmisor": "Santiago"
```

Con esto el agente entra al SII, selecciona la empresa y firma sin que toques
nada. Sin esto, el login y la firma los haces tú a mano en la ventana que abre.

### Paso 7. Probar sin riesgo

```bash
pnpm agent prepare --mode simulation
pnpm agent test-email
```

El primero valida el Excel completo sin tocar el SII. El segundo envía un
correo `[PRUEBA]` a tu propio buzón para verificar el remitente (alias).

---

## Parte 2 — Cómo llenar el Excel

Reglas de oro:

- ⛔ **Nunca escribas en `tblFacturas`** — la llena el agente.
- 📅 Las **fechas** se escriben con apóstrofe adelante: `'2026-07-01` (así
  Excel no las convierte y quedan como texto `AAAA-MM-DD`).
- 🔤 No cambies nombres de tablas ni encabezados.

### `tblEmpresas` — tu(s) empresa(s)

| Columna | Qué poner | Ejemplo |
|---|---|---|
| `empresa_id` | Código estable (igual al del llavero) | `EMP-001` |
| `rut_emisor` | RUT de la empresa, con guion | `77.859.563-K` |
| `razon_social` | Nombre legal | `CTA CONSULTORES` |
| `email_remitente` | Correo remitente de las facturas | `apsijas@ctaconsultores.cl` |
| `email_copia` | Quién recibe copia | `fnaranjo@ctaconsultores.cl` |
| `activo` | `SI` o `NO` | `SI` |

### `tblClientes` — a quién facturas

| Columna | Qué poner | Ejemplo |
|---|---|---|
| `cliente_id` | Código único | `CLI-027` |
| `razon_social` | Nombre del cliente | `CRISTIAN ROMERO` |
| `nombre_carpeta` | Carpeta para sus PDFs | `CRISTIAN ROMERO` |
| `rut_cliente` | RUT con guion | `13.634.130-8` |
| `email_facturacion` | Correo(s), varios con `;` | `cromero@alterland.cl` |
| `giro` | Actividad (opcional*) | `Propiedades` |
| `direccion` | Opcional* | |
| `comuna` | **Obligatoria** | `Las Condes` |
| `ciudad` | **Obligatoria** | `Santiago` |
| `activo` | `SI` o `NO` | `SI` |

*El SII suele completar giro y dirección desde su padrón.

### `tblCobrosRecurrentes` — qué cobras cada mes

| Columna | Qué poner | Ejemplo CLP | Ejemplo UF |
|---|---|---|---|
| `cobro_id` | Código único | `COB-004` | `COB-005` |
| `empresa_id` | Tu empresa | `EMP-001` | `EMP-001` |
| `cliente_id` | El cliente | `CLI-027` | `CLI-028` |
| `descripcion_servicio` | Texto en la factura | `Contabilidad mensual` | `Asesoría mensual` |
| `moneda` | `CLP` o `UF` | `CLP` | `UF` |
| `monto_neto` | CLP: entero · UF: admite decimales | `100000` | `15,5` |
| `cantidad` | Normalmente 1 | `1` | `1` |
| `frecuencia` | Siempre `MENSUAL` | `MENSUAL` | `MENSUAL` |
| `dia_emision` | Día del mes (1–28)** | `24` | `24` |
| `forma_pago` | `CONTADO` o `CREDITO` | `CONTADO` | `CREDITO` |
| `dias_vencimiento` | 0 si contado; días si crédito | `0` | `30` |
| `fecha_inicio` | Desde cuándo rige (con apóstrofe) | `'2026-07-01` | `'2026-08-01` |
| `fecha_fin` | Vacía = indefinido | | |
| `activo` | `SI` o `NO` | `SI` | `SI` |

**Todos los cobros de un mismo cliente deben tener el mismo `dia_emision`.

Con `moneda` = `UF`, el agente busca solo el **valor oficial de la UF** del día
de emisión en sii.cl, convierte a pesos y registra el valor usado. Si la UF de
esa fecha no está publicada, la factura se bloquea (nunca inventa valores).

### Recetas rápidas

| Quiero… | Hago… |
|---|---|
| Agregar un cliente | 1 fila en `tblClientes` + 1 en `tblCobrosRecurrentes` |
| Cobrar en UF a un cliente | En su fila de cobro: `moneda` = `UF`, `monto_neto` en UF |
| Cambiar un monto | Editar `monto_neto` (rige desde la próxima factura) |
| Dejar de facturar a alguien | `activo` = `NO` en su fila de cobro |
| Dos servicios en una factura | Dos filas de cobro, mismo `cliente_id` y mismo `dia_emision` |

---

## Parte 3 — Uso mensual (el día de emisión)

Siempre desde la carpeta del proyecto:

```bash
cd "/Users/andrespsijas/Documents/Codex/agente factura sii"
```

### Paso 1. Preparar las facturas del día

```bash
pnpm agent prepare --mode simulation
```

(o `--date 2026-07-24` para un día específico). Resultado:

| Lista | Significado |
|---|---|
| `preparadas` | Facturas nuevas listas para aprobar |
| `omitidas` | Ya existían (protección antiduplicados) |
| `bloqueadas` | Datos inconsistentes — revisa el motivo |
| `atrasadas` | Su día ya pasó este mes; requieren decisión tuya |

Cada preparada aparece también en `tblFacturas` como `PENDIENTE_APROBACION`.

### Paso 2. Emitir (una por una)

```bash
pnpm agent emit --invoice RECURRENT:EMP-001:CLI-027:2026-07
```

El agente abre el SII y hace todo solo. Se detiene una única vez y te muestra
el resumen: **verifica cliente y total**. Si está correcto, escribe la línea
completa tal cual la indica y presiona Enter:

```
APROBAR RECURRENT:EMP-001:CLI-027:2026-07
```

⚠️ Cualquier otra respuesta (incluso `APROBAR` a secas) se toma como rechazo y
no se emite — es la garantía de que apruebas una factura específica.

Después de aprobar, **no cierres la ventana del SII**: el agente firma,
captura el folio, guarda el PDF y envía el correo. Al final verás en la
Terminal el folio y el estado `ENVIADA`.

### Paso 3. Verificar (opcional)

- PDF: `cliente/<nombre_carpeta>/<AAAA>/<MM>/Factura_<folio>_..._.pdf`
- Excel: la fila en `tblFacturas` con folio, estado y fecha de envío.

---

## Parte 4 — Situaciones especiales

### El correo falló pero la factura se emitió

El folio y el PDF están a salvo. Cuando el problema (alias, red) esté resuelto:

```bash
pnpm agent retry-email --invoice <factura_id>
```

Este comando **solo** reenvía el correo; jamás vuelve a emitir.

### Ensayar sin emitir

```bash
pnpm agent preview-sii --invoice <factura_id>
```

Llena la factura real en el SII, compara totales y se detiene **antes** de
firmar. Útil para revisar un cliente nuevo antes del día real.

### Tabla de problemas

| Síntoma | Solución |
|---|---|
| `Command "agent" not found` | Te falta el `cd` a la carpeta del proyecto |
| `Fecha debe ser AAAA-MM-DD` | Reescribe la fecha en el Excel con apóstrofe: `'2026-07-01` |
| `Celda numérica vacía` | Falta un número en la fila del cobro |
| `prepare` no prepara nada | El `dia_emision` no coincide con la fecha; usa `--date` |
| `Aprobación denegada o texto incorrecto` | Vuelve a correr `emit` y pega la línea `APROBAR ...` completa |
| Remitente del correo incorrecto | Falta habilitar el alias en Exchange (avisar al administrador M365) |
| Factura en `REQUIERE_REVISION` | **Primero** mira en el SII (documentos emitidos) si existe; luego pide ayuda para regenerar o adoptar el folio. Nunca re-emitas por tu cuenta |
| El SII pide captcha/verificación | Complétala tú en la ventana; el agente espera |
| Pide código de Microsoft otra vez | Normal si expiró el cache; una vez y queda guardado de nuevo |

### Estados de una factura

| Estado | Significado |
|---|---|
| `PENDIENTE_APROBACION` | Preparada, esperando tu `APROBAR` |
| `EMITIENDO` | En plena emisión (transitorio) |
| `EMITIDA` | El SII asignó folio |
| `DESCARGADA` | PDF verificado y archivado |
| `ENVIADA` | Correo enviado — ciclo completo ✅ |
| `ERROR_REINTENTABLE` | Falló correo/PDF; se recupera con `retry-email` |
| `REQUIERE_REVISION` | Necesita revisión humana; nada automático puede re-emitirla |
| `CANCELADA` | Descartada antes de emitir |

---

## Seguridad — lo que el agente nunca hace

- Nunca emite sin tu `APROBAR <factura_id>` textual.
- Nunca reintenta una emisión: ante cualquier duda, se detiene y te avisa.
- Nunca guarda claves en archivos, Excel, Git ni logs — solo el llavero de macOS.
- Nunca evade captchas ni verificaciones del SII: eso siempre es tuyo.
- Nunca modifica tus tablas de empresas, clientes o cobros — solo `tblFacturas`.
