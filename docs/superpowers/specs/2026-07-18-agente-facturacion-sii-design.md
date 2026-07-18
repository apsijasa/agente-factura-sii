# Diseño del agente local de facturación SII

Fecha: 2026-07-18  
Estado: aprobado por el usuario

## 1. Objetivo

Construir un agente local que lea cobros recurrentes desde un libro Excel alojado en OneDrive, prepare una factura electrónica en el Sistema de Facturación Gratuito del SII, solicite aprobación humana antes de emitir, descargue el PDF, lo archive localmente, lo envíe por Microsoft 365 y registre una auditoría completa.

La primera versión se ejecutará en macOS desde:

```text
/Users/andrespsijas/Documents/Codex/agente factura sii
```

Los documentos emitidos se archivarán debajo de:

```text
/Users/andrespsijas/Documents/Codex/agente factura sii/cliente
```

## 2. Alcance

### Incluido en el MVP

- Una empresa emisora activa, con arquitectura preparada para múltiples emisores.
- Múltiples clientes y múltiples servicios recurrentes por cliente.
- Lectura y actualización del libro de OneDrive mediante Microsoft Graph.
- Valores netos en CLP o UF; toda factura del MVP es afecta a IVA.
- Consulta del valor UF oficial correspondiente a la fecha de emisión.
- Una factura mensual por empresa, cliente y período, con una línea por servicio.
- Automatización asistida del portal del SII mediante Playwright con navegador visible.
- Aprobación humana local antes de la emisión.
- Descarga, verificación y archivo del PDF.
- Envío por Microsoft Graph desde el alias configurado y con copia al correo definido.
- Persistencia local en SQLite y trazabilidad paralela en `tblFacturas`.
- Modos de simulación, vista previa en SII y emisión real.
- Pruebas unitarias, de integración simulada y una ruta de validación real controlada.

### Fuera del MVP

- Bot de Telegram.
- Escenarios de Make.com.
- Ejecución completamente autónoma sin aprobación.
- Despliegue permanente en la nube.
- Emisión directa de XML DTE mediante software propio certificado.
- Notas de crédito, notas de débito y facturas exentas.
- Cobros extraordinarios solicitados por mensajería.
- Activación automática de un programador mensual. El MVP ofrecerá comandos manuales seguros; la programación local se añadirá después de validar emisiones reales.

Telegram, Make.com, programación automática y cobros extraordinarios deberán consumir el mismo núcleo de dominio en fases posteriores, sin duplicar la lógica tributaria.

## 3. Principios de seguridad

1. El modo predeterminado siempre será `simulacion`.
2. Ninguna factura se emitirá sin una aprobación explícita vinculada al contenido exacto.
3. Una respuesta incierta del SII nunca provocará un segundo clic automático de emisión.
4. Las credenciales, tokens y sesiones no se incluirán en código, Excel, Git, prompts ni logs.
5. El agente no evadirá CAPTCHA, MFA u otros controles de seguridad.
6. Las operaciones se detendrán ante datos ambiguos, valores UF faltantes o diferencias de totales.
7. La contraseña tributaria compartida durante el levantamiento debe rotarse antes de cualquier prueba real.

## 4. Fuente de datos

El libro de OneDrive contiene cuatro tablas con nombres estables:

- `tblEmpresas`
- `tblClientes`
- `tblCobrosRecurrentes`
- `tblFacturas`

### `tblEmpresas`

```text
empresa_id | rut_emisor | razon_social | email_remitente | email_copia | activo
```

`email_remitente` contiene el alias visible. El buzón principal utilizado para autenticación se proporciona mediante configuración local y no se obtiene de esta tabla.

### `tblClientes`

```text
cliente_id | razon_social | nombre_carpeta | rut_cliente | email_facturacion | giro | direccion | comuna | ciudad | activo
```

`giro` y `direccion` pueden estar vacíos si el SII los recupera por RUT. Si el portal exige completarlos manualmente y no existen en el libro, la factura pasa a `REQUIERE_REVISION`.

### `tblCobrosRecurrentes`

```text
cobro_id | empresa_id | cliente_id | descripcion_servicio | moneda | monto_neto | cantidad | frecuencia | dia_emision | forma_pago | dias_vencimiento | fecha_inicio | fecha_fin | activo
```

Reglas:

- `moneda`: `CLP` o `UF`.
- `monto_neto`: monto unitario neto en la moneda de la fila.
- `cantidad`: número positivo.
- `frecuencia`: `MENSUAL` en el MVP.
- `dia_emision`: entero entre 1 y 28.
- `forma_pago`: `CONTADO` o `CREDITO`.
- Si `forma_pago` es `CONTADO`, `dias_vencimiento` debe ser cero.
- Todos los servicios activos del mismo cliente deben tener el mismo día de emisión. Una diferencia bloquea el grupo.
- `fecha_fin` vacía significa vigencia indefinida.
- La fecha programada se obtiene combinando el período mensual con `dia_emision`.
- Una ejecución atrasada se detecta y reporta, pero el agente no retrodata una factura ni elige una nueva fecha de emisión por cuenta propia. El grupo pasa a `REQUIERE_REVISION`.

### `tblFacturas`

```text
factura_id | cobro_id | periodo | fecha_emision | valor_uf | monto_neto_clp | iva_clp | total_clp | folio_sii | estado | pdf_path | aprobada_por | fecha_aprobacion | fecha_envio | error
```

Cuando una factura agrupe varios servicios, `cobro_id` contendrá los identificadores ordenados y separados por punto y coma. SQLite conservará la relación normalizada entre factura y cobros.

El agente solo añadirá o actualizará filas en `tblFacturas`; no modificará automáticamente empresas, clientes ni cobros recurrentes.

## 5. Arquitectura

La aplicación será un CLI modular en Node.js y TypeScript.

```text
OneDrive/Excel
      |
      v
Validación y agrupación ----> Proveedor UF oficial
      |
      v
Preparación y vista previa
      |
      v
Aprobación local
      |
      v
Playwright/SII
      |
      +----> PDF y almacenamiento local
      |
      +----> Microsoft Graph/Correo
      |
      v
SQLite + tblFacturas
```

### Componentes

#### `ExcelAdapter`

- Resuelve el libro a un `driveId` e `itemId` durante una configuración interactiva que solicita el enlace sin incluirlo en argumentos de terminal ni archivos versionados.
- Lee las cuatro tablas por Microsoft Graph.
- Usa una sesión de libro cuando corresponda.
- Actualiza exclusivamente `tblFacturas`.
- Valida que los encabezados y nombres de tabla sean exactos antes de procesar.

#### `InvoiceEngine`

- Normaliza y valida RUT, IDs, fechas, correos, monedas y montos.
- Selecciona cobros vigentes para la fecha solicitada.
- Agrupa por empresa, cliente y período.
- Exige un día de emisión común dentro del grupo.
- Crea una identidad determinista para la factura mensual.
- Produce un payload inmutable que será firmado lógicamente mediante hash para la aprobación.
- Detecta períodos vencidos sin factura y los informa como `REQUIERE_REVISION`; no los omite ni los emite con una fecha inventada.

#### `UfProvider`

- Consulta exclusivamente la tabla pública oficial del SII del año correspondiente.
- Extrae el valor exacto de la fecha de emisión.
- Valida formato, fecha y rango razonable.
- Registra valor, fecha, URL de origen y momento de consulta.
- No utiliza silenciosamente fuentes no oficiales.
- Si el valor no existe o no puede verificarse, bloquea la factura.

Fuente prevista:

```text
https://www.sii.cl/valores_y_fechas/uf/uf{AAAA}.htm
```

#### `SiiAdapter`

- Usa Playwright en modo visible durante el MVP.
- Mantiene la lógica del portal detrás de una interfaz reemplazable.
- Obtiene la credencial tributaria desde el llavero de macOS.
- Usa el certificado digital instalado en el equipo.
- Selecciona el emisor y completa los datos de cada línea.
- Usa el tipo de venta y tipo de compra elegidos explícitamente durante la configuración del emisor; si faltan, el preflight bloquea la ejecución.
- Se detiene en la vista previa antes de emitir.
- Extrae neto, IVA y total mostrados por el SII y los compara con los esperados.
- Emite una sola vez después de validar la aprobación vigente.
- Obtiene el folio y descarga el PDF.
- Ante una respuesta incierta, consulta documentos emitidos antes de permitir otra acción.

Los localizadores de Playwright estarán centralizados, usarán roles, etiquetas y texto estable antes que selectores CSS frágiles, y tendrán pruebas con fixtures sanitizados.

#### `ApprovalService`

- Muestra empresa, cliente, RUT parcialmente oculto, líneas, UF, neto, IVA, total, destinatarios y ruta prevista.
- Solicita el texto exacto `APROBAR <factura_id>`.
- Calcula un hash SHA-256 de la representación canónica del payload.
- Incluye en el hash emisor, receptor, fecha, período, clasificación SII, forma de pago, líneas, UF, neto, IVA, total, remitente, destinatarios y copia.
- Registra actor, hash y fecha.
- Invalida la aprobación si cambia cualquier dato del payload o de la vista previa del SII.
- Expira la interacción si no se aprueba dentro del tiempo configurado.

#### `StorageService`

- Sanea `nombre_carpeta` y verifica que la ruta final permanezca dentro de la raíz autorizada.
- Crea carpetas con año de cuatro dígitos y mes de dos dígitos.
- Descarga primero a un archivo temporal y realiza un cambio de nombre atómico al verificarlo.
- Verifica existencia, tamaño mayor que cero y tipo PDF.

Ruta:

```text
cliente/<nombre_carpeta>/<AAAA>/<MM>/Factura_<folio>_<cliente>_<AAAA-MM>.pdf
```

#### `MailService`

- Autentica el buzón principal mediante OAuth y Microsoft Graph.
- Usa el alias de `tblEmpresas.email_remitente` como remitente visible.
- Envía a `tblClientes.email_facturacion` y copia a `tblEmpresas.email_copia`.
- Admite varios destinatarios válidos separados por punto y coma.
- Adjunta el PDF verificado.
- Conserva una copia en Elementos enviados.
- Comprueba durante el preflight que Exchange Online permita enviar desde el alias.
- Si el alias no está habilitado o es reescrito, no envía y mantiene la factura en `DESCARGADA`.
- Un reintento de correo nunca vuelve a emitir la factura.

#### `AuditStore`

SQLite será la fuente operativa local para idempotencia y recuperación. Como mínimo contendrá:

- `invoice_runs`
- `invoice_lines`
- `state_events`
- `approvals`
- `email_attempts`

La clave única de una factura recurrente será:

```text
RECURRENT:<empresa_id>:<cliente_id>:<AAAA-MM>
```

Una fase posterior podrá usar claves `EXTRA:<uuid>` para cobros extraordinarios sin debilitar la protección del ciclo recurrente.

#### `FacturasRepository`

- Refleja en `tblFacturas` los estados y resultados relevantes.
- Reconcilia SQLite con Excel al iniciar.
- Si encuentra una contradicción entre un folio existente y el estado local, detiene el proceso y exige revisión.

## 6. Cálculos

Todos los importes son netos. El agente no ingresa IVA manualmente en el portal, pero calcula una expectativa para validación.

Se utilizará aritmética decimal explícita y redondeo `ROUND_HALF_UP`.

### Línea CLP

```text
precio_unitario_clp = monto_neto
total_linea_clp = precio_unitario_clp * cantidad
```

`monto_neto` debe ser un entero para CLP.

### Línea UF

```text
precio_unitario_clp = redondear(monto_neto_uf * valor_uf_fecha)
total_linea_clp = precio_unitario_clp * cantidad
```

### Totales esperados

```text
neto_esperado = suma(total_linea_clp)
iva_esperado = redondear(neto_esperado * 0,19)
total_esperado = neto_esperado + iva_esperado
```

La fecha de vencimiento será igual a la fecha de emisión para `CONTADO`. Para `CREDITO`, será la fecha de emisión más `dias_vencimiento`. La forma de pago y la fecha de vencimiento forman parte de la aprobación.

Los totales mostrados por el SII son autoritativos. Si no coinciden exactamente con la expectativa, el agente no emitirá y marcará `REQUIERE_REVISION`.

## 7. Flujo operativo

### Simulación

```text
pnpm agent -- prepare --mode simulation [--date AAAA-MM-DD]
```

1. Preflight de configuración.
2. Lectura del libro.
3. Validación y selección de cobros cuya fecha programada coincide con la fecha solicitada.
4. Detección separada de períodos atrasados, que quedan en revisión sin emisión.
5. Consulta UF cuando sea necesaria.
6. Agrupación y cálculo.
7. Escritura de `BORRADOR` y `PENDIENTE_APROBACION`.
8. Generación de vista previa local.
9. No abre el SII y no envía correos.

### Vista previa SII

```text
pnpm agent -- preview-sii --invoice <factura_id>
```

1. Reconstruye el payload y confirma que no cambió.
2. Abre el SII y completa la factura.
3. Extrae y compara los totales.
4. Guarda evidencia local.
5. Se detiene antes del acto de emisión.

### Emisión real

```text
pnpm agent -- emit --invoice <factura_id>
```

1. Repite el preflight y la vista previa.
2. Solicita `APROBAR <factura_id>`.
3. Verifica el hash aprobado.
4. Cambia a `APROBADA` y luego `EMITIENDO`.
5. Ejecuta una sola acción final de emisión.
6. Obtiene confirmación y folio.
7. Cambia a `EMITIDA`.
8. Descarga y verifica el PDF.
9. Cambia a `DESCARGADA`.
10. Envía el correo.
11. Cambia a `ENVIADA`.

### Reintento de correo

```text
pnpm agent -- retry-email --invoice <factura_id>
```

Solo está permitido para una factura con folio y PDF verificado. No invoca `SiiAdapter`.

## 8. Máquina de estados

Estados persistidos:

```text
BORRADOR
PENDIENTE_APROBACION
APROBADA
EMITIENDO
EMITIDA
DESCARGADA
ENVIADA
ERROR_REINTENTABLE
REQUIERE_REVISION
CANCELADA
```

Transiciones principales:

```text
BORRADOR -> PENDIENTE_APROBACION
PENDIENTE_APROBACION -> APROBADA | CANCELADA
APROBADA -> EMITIENDO
EMITIENDO -> EMITIDA | REQUIERE_REVISION
EMITIDA -> DESCARGADA | ERROR_REINTENTABLE
DESCARGADA -> ENVIADA | ERROR_REINTENTABLE
ERROR_REINTENTABLE -> DESCARGADA | ENVIADA | REQUIERE_REVISION
```

No se permite volver de `EMITIDA` a un estado que pueda ejecutar otra emisión.

## 9. Autenticación y configuración

### SII

- Credencial almacenada como secreto genérico en el llavero de macOS.
- Ningún argumento CLI acepta contraseñas.
- El agente redacta credenciales y datos tributarios en errores y logs.

### Microsoft Graph

El MVP usa autenticación delegada por código de dispositivo. Permisos mínimos previstos:

```text
User.Read
Files.ReadWrite
Mail.Send
offline_access
```

El token cache se cifra localmente. Los permisos y el comportamiento del alias deben validarse durante `preflight`.

### Configuración local

La configuración no versionada incluirá:

- Tenant y client ID de la aplicación Microsoft Entra.
- `driveId`, `itemId` y nombres de tablas.
- Buzón principal de autenticación.
- Tipo de venta y tipo de compra seleccionados explícitamente para cada emisor durante el asistente de configuración. El agente no asigna una clasificación tributaria predeterminada.
- Rutas locales autorizadas.
- Tiempos de espera.
- Modo predeterminado, que siempre será simulación.

`.gitignore` debe excluir como mínimo:

```text
.env
.data/
*.sqlite*
playwright/.auth/
test-results/
```

## 10. Manejo de errores

- OneDrive, Graph y consulta UF: hasta tres reintentos con backoff exponencial y jitter.
- Navegación del SII antes de emitir: un reintento controlado.
- Acción de emisión: ningún reintento automático.
- Resultado incierto: `REQUIERE_REVISION` y consulta de documentos emitidos.
- Correo fallido: `ERROR_REINTENTABLE`, conservando folio y PDF.
- Cambio inesperado del portal: captura, traza y detención segura.
- Datos maestros incompletos: error de validación antes de abrir el SII.
- Ejecución concurrente: bloqueo de proceso; solo un flujo SII puede estar activo.

Los logs serán estructurados y redactarán contraseñas, tokens, cookies, RUT completos, correos y contenido de sesión. Las evidencias se guardarán en `.data/evidence` con permisos locales restrictivos y política de retención configurable.

## 11. Estrategia de pruebas

### Unitarias

- Módulo 11 para RUT.
- Normalización de entradas.
- Fechas de vigencia.
- Agrupación de múltiples servicios.
- Conflicto de días de emisión.
- Conversión UF a CLP y redondeo.
- Totales esperados.
- Construcción y confinamiento de rutas.
- Hash canónico de aprobación.
- Máquina de estados.
- Idempotencia y duplicados.

### Integración simulada

- Fixtures locales de las cuatro tablas.
- Adaptador Graph simulado.
- Proveedor UF simulado con fecha exacta.
- Páginas del SII sanitizadas como fixtures de selectores.
- Descarga PDF simulada.
- Correo simulado con validación de destinatarios y adjunto.

Las pruebas automáticas nunca accederán al SII real ni enviarán correos reales.

### Validación controlada

1. Simulación con datos reales de OneDrive.
2. Vista previa real en el SII sin emitir.
3. Prueba de correo redirigida al buzón principal y con asunto `[PRUEBA]`.
4. Una única emisión real seleccionada y aprobada por el usuario.
5. Revisión de folio, PDF, carpeta, correo, SQLite y Excel.

### Comandos de calidad

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## 12. Criterios de aceptación

El MVP se considera terminado cuando:

1. Lee y valida las cuatro tablas exactas desde OneDrive.
2. Agrupa varias líneas en una factura mensual por cliente.
3. Usa y registra el valor UF oficial de la fecha de emisión.
4. Arranca en simulación y no tiene rutas implícitas hacia emisión real.
5. Exige aprobación explícita y la invalida ante cualquier cambio.
6. Detecta duplicados tras reiniciar o reconciliar Excel y SQLite.
7. Compara exactamente los totales del SII con los esperados.
8. Obtiene y persiste el folio sin reintentos ciegos.
9. Guarda un PDF válido en la ruta anual y mensual correcta.
10. Envía desde el alias al cliente y con la copia configurada.
11. Reintenta un correo sin volver a emitir.
12. Registra cada transición en SQLite y refleja el resultado en Excel.
13. No expone secretos ni datos sensibles en código, Git o logs.
14. Supera lint, tipos, pruebas y compilación.
15. Incluye documentación reproducible para configurar Microsoft Entra, Keychain, OneDrive, certificado, alias, simulación y primera emisión.

## 13. Evolución posterior

### Fase 2

- Bot de Telegram restringido a usuarios autorizados.
- Aprobación por Telegram usando el mismo hash de payload.
- Alta de clientes y cobros con confirmación y validación.
- Facturas extraordinarias con identificador propio.

### Fase 3

- Make.com para disparadores, alertas y orquestación no tributaria.
- Programación local diaria o mensual una vez validado el MVP.
- Aprobación configurable por cliente o monto.

### Fase 4

- Sustituir `SiiAdapter` por un proveedor certificado o integración DTE propia.
- Ejecutar el núcleo en la nube.
- Automatización sin aprobación bajo políticas y límites explícitos.

## 14. Fuentes oficiales consultadas

- Requisitos técnicos del Sistema de Facturación Gratuito del SII: https://www.sii.cl/preguntas_frecuentes/factura_electronica/001_003_3587.htm
- Guía de emisión de factura electrónica: https://www.sii.cl/destacados/factura_electronica/guias_ayuda/emitir_factura_electronica.pdf
- Valores diarios de UF del SII: https://www.sii.cl/valores_y_fechas/uf/uf2026.htm
- Microsoft Graph `sendMail`: https://learn.microsoft.com/en-us/graph/api/user-sendmail
- Envío desde otra dirección con Microsoft Graph: https://learn.microsoft.com/en-us/graph/outlook-send-mail-from-other-user
- Configuración de envío desde alias en Exchange Online: https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/set-organizationconfig
