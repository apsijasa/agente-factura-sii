# Guía de operación

Cómo operar el agente mes a mes, cómo escribir el Excel y qué hacer ante cada
situación. La configuración inicial (una sola vez) está en [setup.md](setup.md).

## El ciclo mensual

El día de emisión (columna `dia_emision` de cada cobro), desde la carpeta del
proyecto:

```bash
pnpm agent prepare --mode simulation
```

Sin `--date` usa el día actual. Prepara una factura por cliente cuyo día de
emisión sea hoy y la deja en `PENDIENTE_APROBACION` (visible en `tblFacturas`).
Las ya preparadas salen en `omitidas` (antiduplicados). Luego, por cada factura:

```bash
pnpm agent emit --invoice RECURRENT:EMP-001:<cliente_id>:<AAAA-MM>
```

El agente hace todo el portal solo y se detiene una única vez: el resumen de
aprobación. Revisar cliente y montos, y escribir el texto exacto en una línea:

```
APROBAR RECURRENT:EMP-001:<cliente_id>:<AAAA-MM>
```

Después de aprobar: firma automática, folio, PDF archivado y correo enviado.
**No cerrar la ventana del SII** — el agente la cierra al terminar.

## Cómo escribir el Excel

Tres reglas generales:

- **Nunca escribir en `tblFacturas`** — esa tabla la llena el agente.
- Las **fechas** van como texto `AAAA-MM-DD`: escribirlas con apóstrofe
  (`'2026-07-01`) para que Excel no las convierta.
- No cambiar nombres de hojas, tablas ni encabezados.

### `tblEmpresas` — la(s) empresa(s) emisora(s)

| Columna | Formato |
|---|---|
| `empresa_id` | Código estable (ej `EMP-001`); debe coincidir con las cuentas del llavero |
| `rut_emisor` | RUT válido con guion (`77.859.563-K`) |
| `email_remitente` | Alias visible del correo de facturas |
| `email_copia` | Quién recibe copia de cada factura |
| `activo` | `SI` / `NO` |

### `tblClientes` — a quién se factura

| Columna | Formato |
|---|---|
| `cliente_id` | Código estable único (ej `CLI-027`) |
| `nombre_carpeta` | Carpeta local para sus PDFs (sin `/` ni símbolos) |
| `rut_cliente` | RUT válido con guion |
| `email_facturacion` | Uno o varios correos separados por `;` |
| `giro`, `direccion` | Opcionales (el padrón del SII suele completarlos) |
| `comuna`, `ciudad` | **Obligatorias** (el SII las exige) |
| `activo` | `SI` / `NO` |

### `tblCobrosRecurrentes` — qué se cobra

| Columna | Formato |
|---|---|
| `cobro_id` | Código único (ej `COB-004`) |
| `empresa_id` / `cliente_id` | Deben existir en las otras tablas |
| `descripcion_servicio` | Texto de la línea en la factura |
| `moneda` | `CLP` o `UF` |
| `monto_neto` | CLP: entero (`300000`). UF: cantidad de UF, admite decimales (`15,5`) |
| `cantidad` | Normalmente `1` |
| `frecuencia` | `MENSUAL` (única soportada) |
| `dia_emision` | 1 a 28. **Todos los cobros de un mismo cliente deben tener el mismo día** |
| `forma_pago` | `CONTADO` (con `dias_vencimiento` = 0) o `CREDITO` (con días > 0) |
| `fecha_inicio` | `'2026-07-01` (texto). Desde cuándo rige |
| `fecha_fin` | Vacía = indefinido; o fecha de término |
| `activo` | `SI` / `NO` |

### Recetas frecuentes

- **Cliente nuevo**: una fila en `tblClientes` + una en `tblCobrosRecurrentes`.
- **Cobrar en UF**: en la fila del cobro, `moneda` = `UF` y `monto_neto` en UF.
  El agente busca el valor oficial de la UF del día de emisión en sii.cl,
  convierte a pesos (redondeo half-up) y registra el valor usado en
  `tblFacturas.valor_uf` y la procedencia en la auditoría. Si la UF de esa
  fecha no está publicada, la factura se bloquea (no inventa valores).
- **Cambiar un monto**: editar `monto_neto`; rige desde la próxima factura que
  se prepare (las ya preparadas no cambian).
- **Dejar de facturar a un cliente**: `activo` = `NO` en su fila de cobro (o
  `fecha_fin` con la última fecha válida).
- **Varias líneas en una factura**: varias filas de cobro con el mismo
  `cliente_id` y el mismo `dia_emision`.

## Estados de una factura

`BORRADOR → PENDIENTE_APROBACION → APROBADA → EMITIENDO → EMITIDA →
DESCARGADA → ENVIADA`, con `ERROR_REINTENTABLE` (recuperable),
`REQUIERE_REVISION` (revisión humana) y `CANCELADA`. Después de `EMITIDA` no
existe ningún camino de vuelta hacia una nueva emisión.

## Problemas y soluciones

| Síntoma | Causa y solución |
|---|---|
| `Command "agent" not found` | Estás fuera de la carpeta del proyecto: `cd "/Users/andrespsijas/Documents/Codex/agente factura sii"` |
| `Fecha debe ser AAAA-MM-DD` / `Fecha inexistente` | Celda de fecha convertida por Excel: reescribir con apóstrofe (`'2026-07-01`) |
| `Celda numérica vacía` | Falta un número en el cobro (p. ej. `dias_vencimiento`) |
| `prepare` no encuentra nada | El `dia_emision` no coincide con la fecha pedida; usar `--date` del día correcto |
| `Aprobación denegada o texto incorrecto` | Se escribió el `APROBAR ...` incompleto; volver a correr `emit` y pegar la línea completa |
| Correo falla o alias reescrito | La factura queda con folio y PDF a salvo; arreglar el alias/red y `pnpm agent retry-email --invoice <id>` |
| Factura en `REQUIERE_REVISION` | **Primero** verificar en el SII (documentos emitidos) si el documento existe. Si NO existe: avisar para limpiar y regenerar. Si SÍ existe: avisar para adoptar el folio en la auditoría — jamás re-emitir |
| El SII pide captcha/verificación | Resolverla a mano en la ventana; el agente espera |
| Pide de nuevo el código de Microsoft | Normal solo la primera vez o si el cache expiró; una vez y queda guardado |

## Dónde queda cada cosa

- **PDFs**: `cliente/<nombre_carpeta>/<AAAA>/<MM>/Factura_<folio>_<carpeta>_<AAAA-MM>.pdf`
- **Auditoría completa** (estados, aprobaciones, valor UF usado, intentos de
  correo): `.data/agente.sqlite`
- **Espejo para lectura rápida**: `tblFacturas` en el Excel
- **Evidencia de cada sesión SII**: `.data/evidence/`
- **Secretos**: llavero de macOS (`agente-factura-sii`, cuentas `EMP-001`,
  `EMP-001-firma`, `msal-cache-key`)
