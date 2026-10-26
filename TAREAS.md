# Tareas pendientes

Estado al **26-10-2026**. Verificado contra el repo en `09cf9e4`, los workflows
de GitHub y una revisión de código de la migración a Cloudflare.

Lee `AGENTS.md` antes de tomar cualquiera de estas. Cada tarea trae dónde
mirar y cómo comprobar que quedó bien.

---

## 🔴 0. Workflow para cancelar una factura preparada

**Se necesita ahora:** la factura `RECURRENT:EMP-001:CLI-031:2026-10` (SOCIEDAD
MMP, $122.024 aprox.) quedó preparada el 25-10 y **no se debe emitir**: el
cliente se desactivó en el Excel después de prepararla (`COB-011` y `CLI-031`
quedaron con `activo = NO`). Mientras siga en `PENDIENTE_APROBACION`, el agente
reenvía su enlace de aprobación todos los días.

**Por qué un workflow y no el CLI local:** `cancel` existe
(`src/cli/index.ts:140`) pero necesita `CF_API_URL` y `CF_API_TOKEN` para
escribir en D1. Ese token vive como **GitHub Secret, que es de solo escritura**:
no se puede recuperar para ponerlo en una terminal. Sin esas variables el agente
cae a modo local y cancelaría en el SQLite local, que no es la fuente de verdad.

### Qué construir

`.github/workflows/cancelar.yml`, con disparo **solo manual**
(`workflow_dispatch`, sin `schedule`) y dos entradas obligatorias:

| Entrada | Qué es |
|---|---|
| `invoice` | `factura_id` completo. Formatos válidos: `RECURRENT:<empresa>:<cliente>:<AAAA-MM>` y `PUNTUAL:<empresa>:<cliente>:<fecha>:<id>` |
| `motivo` | Texto libre no vacío. Queda en la auditoría y en `tblFacturas`. |

Ejecuta:
```
pnpm agent cancel --invoice "$INVOICE" --motivo "$MOTIVO"
```

### Requisitos

- **Las entradas viajan por `env:`, nunca interpoladas en el `run:`.** Este job
  lleva credenciales del SII y de Cloudflare; un input incrustado en la shell es
  inyección de comandos. Copia el patrón ya resuelto en
  `prepare-notify.yml` (paso "Preparar facturas del día").
- **Validar `invoice` contra un patrón** antes de pasarlo, y fallar con
  `::error::` si no calza. Validar que `motivo` no venga vacío.
- `concurrency: group: facturacion-sii`, `cancel-in-progress: false`, igual que
  los otros cuatro workflows.
- Secretos necesarios: `CF_API_URL`, `CF_API_TOKEN`, `AGENTE_CONFIG_JSON` y
  `GRAPH_CLIENT_SECRET`. Los dos últimos porque `ejecutarCancel`
  (`src/cli/comandos.ts:260-273`) refleja el resultado en `tblFacturas` vía
  Microsoft Graph, no solo en la auditoría.
- **No** instalar Chromium: este comando jamás toca el SII.
- Mismo chequeo de configuración que los demás: si faltan secretos, terminar sin
  ruido en vez de reventar.

### Lo que NO hay que tocar

`ejecutarCancel` ya tiene las guardas correctas y **no se modifican**: exige
motivo no vacío, y solo cancela desde los estados anteriores a la emisión
(`ESTADOS_CANCELABLES`). Una factura ya emitida no se puede cancelar por acá —
eso es una nota de crédito en el portal, no una transición de estado.

### Cómo verificar

1. Dispararlo con un `factura_id` inexistente → debe fallar con "Factura no
   encontrada", sin tocar nada.
2. Dispararlo con un `invoice` malformado → debe fallar en la validación, antes
   de llegar al agente.
3. Dispararlo con `RECURRENT:EMP-001:CLI-031:2026-10` y un motivo real → la
   factura queda `CANCELADA` y deja de aparecer en las notificaciones diarias.
4. Confirmar que el ciclo siguiente de `prepare-notify` ya **no** la vuelve a
   preparar (el cobro está `activo = NO`, así que no debería).

---

## ✅ 1. `pnpm install` en una clonación nueva — RESUELTA (26-10-2026)

La causa era que pnpm 11 **renombró** `onlyBuiltDependencies` a `allowBuilds` y
dejó de leer el campo `pnpm` de `package.json`. El archivo correcto siempre fue
`pnpm-workspace.yaml`; lo que había cambiado era la clave.

Quedó: `pnpm-workspace.yaml` con `allowBuilds`, `packageManager: pnpm@12.14.0`
en `package.json` como única fuente de verdad de la versión, y los seis
workflows sin `version: 10` para que CI tome esa misma. Verificado en una copia
limpia: `pnpm install --frozen-lockfile && pnpm test` sin pasos manuales.

**Ojo con CI:** desde este cambio los workflows corren con **pnpm 12 en vez de
10**. Se validó con el workflow "Probar canal de notificaciones", que ejercita
`pnpm install --frozen-lockfile` sin tocar facturas ni el SII.

---

## 🔴 2. El token de aprobación se decodifica mal: se rompe con acentos

**Archivo:** `cloudflare/src/index.ts:97`

```ts
datos = JSON.parse(atob(cuerpo.replaceAll('-', '+').replaceAll('_', '/')));
```

`atob()` devuelve latin1. El firmante en Node usa
`Buffer.from(cuerpo, 'base64url').toString()`, que decodifica UTF-8. Las dos
mitades divergen apenas el `factura_id` tenga un byte no ASCII. Comprobado:

```
node  : RECURRENT:ACME:ASESORÍA LTDA:2026-10
worker: RECURRENT:ACME:ASESORÃA LTDA:2026-10
```

**Por qué importa:** el `factura_id` se arma con el `cliente_id` del Excel, que
escribe una persona a mano y no tiene ninguna validación ASCII. Si alguien crea
un cliente con tilde o `ñ`, la firma HMAC valida igual (el base64 es ASCII),
pero el `SELECT` no encuentra la fila y responde 404 "Factura no encontrada".
La factura queda atascada en `PENDIENTE_APROBACION` y el agente reenvía el
mismo enlace roto cada ciclo, sin ningún mensaje que apunte a la causa.

**Falla cerrada** — nunca aprueba algo equivocado. Pero bloquea el camino
crítico. Hoy no afecta a nadie: los clientes actuales van de `CLI-021` a
`CLI-031`, todos ASCII. Es una trampa esperando al primer cliente con tilde.

**Arreglo:**
```ts
const bin = atob(cuerpo.replaceAll('-', '+').replaceAll('_', '/'));
const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
datos = JSON.parse(new TextDecoder().decode(bytes)) as DatosToken;
```

**Verificar:** agregar a `tests/cloudflare/worker.test.ts` un caso con
`factura_id` acentuado. El arnés ya corre el Worker real en Node, así que
reproduce el bug tal cual; solo falta que algún fixture deje de ser ASCII.

---

## 🟠 3. El PDF se sube con una comprobación que no es atómica

**Archivo:** `cloudflare/src/index.ts:339-340`

```ts
if (await env.PDFS.head(clave)) return json({ error: 'YA_EXISTE' }, 409);
await env.PDFS.put(clave, datos, { ... });
```

El comentario promete "equivalente a `upsert:false`" y `docs/cloudflare.md`
afirma "PUT nunca sobrescribe". Con Supabase eso se evaluaba atómicamente en el
servidor; acá hay una ventana entre el `head` y el `put`. La documentación de
R2 es explícita: si dos clientes escriben la misma clave, gana el último.

Es el único invariante que la migración dice preservar y que hoy solo preserva
aproximadamente. El riesgo real es bajo porque los workflows comparten
`concurrency: facturacion-sii`, pero el almacén no debería depender de eso.

**Arreglo** (R2 lo soporta nativo):
```ts
const puesto = await env.PDFS.put(clave, datos, {
  onlyIf: { etagDoesNotMatch: '*' },
  httpMetadata: { contentType: 'application/pdf' },
});
if (puesto === null) return json({ error: 'YA_EXISTE' }, 409);
```

Hay que agregar `onlyIf` a la interfaz `R2Bucket` (`index.ts:34`) y al R2 falso
(`tests/store/cloudflare-falso.ts:54`).

---

## 🟠 4. Emitir varias facturas en una corrida falla una de cada dos

**Archivo:** `src/cli/comandos.ts:413` (`ejecutarEmitAprobadas`)

El bucle llama a `ejecutarEmit` reutilizando **el mismo navegador** para todas
las facturas. Historial medido:

| Fecha | Modo | Resultado |
|---|---|---|
| 25-08 | lote de 11 | 5 fallaron |
| 25-08 | lote de 4 | 2 fallaron |
| 25-08 y 30-09 | de a una | 15 de 15 bien |

El patrón es estrictamente alternado: éxito, fallo, éxito, fallo. **La causa
raíz no está diagnosticada.** Lo que se descartó: no es el parser del folio
(arreglado en `5e61212`), no es la acumulación de ventanas (arreglado en
`f3dd281`). Las páginas de firma son idénticas; la divergencia ocurre después
de pulsar Firmar.

**Importante:** cuando falla, **no deja documento emitido** — verificado contra
el RCV oficial de agosto (los folios 46, 48, 50, 52, 54 y 56 no existen). Falla
cerrada. El costo es operativo: hay que repetir a mano.

**Arreglo propuesto** (no implementado): cerrar el navegador entre facturas con
`deps.sii.cerrar()` en un `finally` dentro del bucle. `cerrar()` deja
`navegador` y `pagina` en `null`, así que la siguiente llamada relanza y vuelve
a autenticarse — replica exactamente las condiciones de "de a una", que nunca
fallaron. Cuesta ~20 s de login por factura.

No arregla la causa raíz: la esquiva. Pero el diagnóstico que se agregó en
`5b3171d` (la alerta del portal y la última URL viajan en el error) debería
revelar la causa en el próximo fallo.

**Verificar:** solo se comprueba con un lote real. No lo pruebes el día 25.

---

## 🟠 5. Perder media credencial desvía la escritura sin avisar

**Archivo:** `src/cli/entorno.ts:40-43`

```ts
export const esNubeCloudflare = () => Boolean(process.env.CF_API_URL && process.env.CF_API_TOKEN);
export const esNubeSupabase = () => !esNubeCloudflare() && Boolean(process.env.SUPABASE_URL && ...);
```

Si se pierde **solo** `CF_API_TOKEN` (una rotación, un typo), el agente no
falla: cae a Supabase, que es una copia congelada al 15-10-2026. Y si los
secretos de Supabase ya se borraron (tarea 6), cae a un SQLite **vacío** en el
workspace efímero del runner. El gate de `emit-approved.yml` solo chequea
`CF_API_URL`, no el token.

Para documentos tributarios, operar contra la fuente de verdad equivocada sin
un error es peor que no operar.

**Arreglo:** si *cualquiera* de `CF_API_*` está presente, exigir ambas y lanzar.
Igual para el par de Supabase. Y que el plan B se active con una variable
explícita (`AGENTE_MODO=supabase`) en vez de por omisión.

---

## 🟠 6. Terminar el paso 8 de la migración: apagar Supabase

`docs/cloudflare.md` lo deja como último paso, una vez que el ciclo del 25
haya corrido en Cloudflare. Ya corrió: octubre se preparó y notificó bien.

- Borrar los secretos `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` de GitHub.
- Pausar o eliminar el proyecto en Supabase.

**Antes de borrar nada:** confirmar que D1 tiene todo lo que Supabase alcanzó a
escribir después del 15-10-2026. Y ojo con el orden — mientras exista la tarea
5, borrar los secretos de Supabase convierte una pérdida de `CF_API_TOKEN` en
"escribe en un SQLite vacío" en vez de "escribe en una copia vieja".

Hacer **5 antes que 6**.

---

## 🟡 7. Arreglos menores de la revisión

| | Qué | Dónde |
|---|---|---|
| M2 | `ApiCloudflare` sin timeout ni reintento. Si el `fetch` de `guardarFolio` cuelga, el folio sobrevive solo en `state_events.detalle`. Son `UPDATE` idempotentes: un `AbortSignal.timeout()` con reintento es seguro y no roza el invariante de "una sola emisión" | `src/store/api-cloudflare.ts:29-44` |
| M3 | Un `expiraEn` no parseable da `NaN`, y `ahora > NaN` es `false`: el enlace nunca vence. Va firmado, así que no es explotable, pero el invariante queda dependiendo del firmante | `cloudflare/src/index.ts:102` y `src/services/token-aprobacion.ts:47` |
| M4 | `crearFactura` del Worker no valida la entrada: sin `lineas` revienta con 500 en vez de 400 | `cloudflare/src/index.ts:244-248` |
| B1 | El error crudo de D1 se responde al chat de Telegram | `cloudflare/src/index.ts:217` |
| B3 | `/aprobar` es un GET con efecto de escritura. Mitigado en Telegram y WhatsApp, queda expuesto el canal de correo: un escáner que haga prefetch registraría la aprobación. Preexistente. Cierre: GET muestra botón, POST confirma | `cloudflare/src/index.ts` |
| B4 | `migrar-pdfs-r2.yml` es el único workflow sin `concurrency: facturacion-sii` | `.github/workflows/` |
| B5 | Falta `Cache-Control: no-store` en el HTML de `/aprobar` | `cloudflare/src/index.ts:108-118` |
| N1 | **Reintento acotado ante corte de red antes de firmar.** El 26-10 el portal del SII cortó la conexión dos veces al navegar a `mipeSelEmpresa.cgi` (`net::ERR_CONNECTION_RESET`), en CLI-022 y CLI-027. Ambas se resolvieron reintentando a mano. Ocurre en `abrirYPreparar`, **antes de llenar el formulario y mucho antes de firmar**, así que no deja documento y reintentar es seguro — no roza el invariante de "una sola emisión", que protege el tramo *posterior* al clic de firma. Un reintento acotado (2 o 3 intentos con espera) ahorraría repetir el ciclo completo | `src/adapters/sii/sii-adapter.ts` (`abrirYPreparar`) |
| N2 | `.data/config.json` apunta a `Documents/Codex/agente factura sii/cliente`, la ruta anterior del repo. En modo nube no molesta (la comprobación se salta), pero **cualquier comando local falla en el preflight** | `.data/config.json` → `rutaRaizClientes` |
| N3 | **El preflight exige la clave del SII a comandos que nunca abren el portal.** `preflight` llama a `leerSecreto(rutEmisor)` sin condición, así que `cancel`, `notify`, `retry-email` y `procesar-solicitudes` necesitan `SII_CLAVE` solo para pasar el chequeo. Obliga a repartir la credencial más importante del sistema a workflows que no la usan. Debería verificarse solo cuando el comando vaya a tocar el SII, con una opción como la que ya existe para `verificarRutaClientes` | `src/config/preflight.ts:44-47` |

---

## 🔵 8. Operativo: octubre está esperando

Las **10 facturas del 25-10 están preparadas y notificadas**, ninguna aprobada.
El gate responde `[]`.

Hay que aprobarlas desde Telegram y emitirlas. **De a una** mientras la tarea 4
siga abierta.

Clientes del lote: CLI-021, 022, 023, 024, 025, 027, 028, 029, 030, 031.
(CLI-026 / JUNCAL está desactivado desde agosto.)

---

## 🔵 9. Pendiente de agosto sin cerrar

El **PDF del folio 42** (DISUADE SPA) nunca le llegó al cliente. La factura se
emitió bien y es válida, pero quedó en `REQUIERE_REVISION` porque el agente no
supo leer el folio — fue el caso que destapó el bug del parser.

Hay que bajarlo del portal del SII y enviarlo a mano. No requiere código.

---

## Lo que la revisión encontró bien resuelto

Vale dejarlo escrito para no "arreglar" lo que ya está bien:

- **El CAS atómico de las transiciones de estado está correctamente portado a
  D1.** `registrarTransicion` mete el `INSERT ... WHERE EXISTS` y el
  `UPDATE ... AND estado = ?` en un mismo `db.batch()`, que es transaccional.
  El evento y el cambio de estado no pueden divergir. Esta es la pieza que
  serializa dos runners concurrentes — el lock de archivo es inútil entre
  ejecuciones distintas, así que el invariante de "una sola emisión" descansa
  sobre este CAS.
- **La aprobación ligada al hash tiene cuatro capas** de revalidación: el token,
  el Worker, la vista `facturas_aprobadas_pendientes` y dos chequeos más en
  `comandos.ts`.
- **La postura de seguridad quedó más estrecha que con RLS**, no más laxa: ya no
  hay superficie REST pública que dependa de políticas bien escritas.
- **`scripts/migrar-pdfs-a-r2.ts` es idempotente y verifica SHA-256 en ambos
  sentidos**, incluso para archivos que ya estaban.
- **El test de contrato** corre las mismas reglas contra las tres
  implementaciones de `IAuditStore`. Es la defensa correcta contra que se
  separen en silencio.

No se encontró ninguna forma de que la migración emita un documento sin
aprobación válida, emita dos veces, ni pierda un folio confirmado.
