# Tareas pendientes

Estado al **26-10-2026**. Verificado contra el repo, los workflows de GitHub y
una revisión de código de la migración a Cloudflare.

Lee `AGENTS.md` antes de tomar cualquiera de estas. Cada tarea trae dónde
mirar y cómo comprobar que quedó bien.

**Cómo se usa:** quien termina una tarea la marca ✅ y la baja a "Resueltas",
en el mismo commit del arreglo. Lo resuelto se conserva un tiempo porque
explica por qué el código quedó como quedó; cuando estorbe, se borra —el
historial de git lo guarda igual.

Para trabajar una: *"Lee AGENTS.md y TAREAS.md. Implementa la tarea 3."*

## Cuáles NO se hacen sin supervisión

Estas exigen una decisión humana o credenciales que un agente no tiene. Si te
topas con una trabajando en otra cosa, **detente y avisa** en vez de resolverla:

| | Por qué |
|---|---|
| **4** | El rodeo ya está puesto, pero sin causa raíz y **sin validar**: solo un lote real lo comprueba. No lo des por cerrado ni lo toques en frío |
| **6** | Borra secretos y pausa un proyecto. Irreversible, y depende de que la 5 esté verificada en producción |

El resto sí se puede tomar de corrido, siempre con los cuatro chequeos en verde
antes de cada commit.

---

## 🟠 4. Emitir varias facturas en una corrida — rodeo puesto, sin validar

**Archivo:** `src/cli/comandos.ts` (`ejecutarEmitAprobadas`)

El bucle reutilizaba **el mismo navegador** para todas las facturas. Historial:

| Fecha | Modo | Resultado |
|---|---|---|
| 25-08 | lote de 11 | 5 fallaron |
| 25-08 | lote de 4 | 2 fallaron |
| 25-08 y 30-09 | de a una | 15 de 15 bien |

El patrón es estrictamente alternado. **La causa raíz sigue sin diagnosticar.**
Descartado: no es el parser del folio (`5e61212`) ni la acumulación de ventanas
(`f3dd281`). Las páginas de firma son idénticas; la divergencia ocurre después
de pulsar Firmar.

Cuando falla **no deja documento emitido** — verificado contra el RCV oficial
de agosto (los folios 46, 48, 50, 52, 54 y 56 no existen). Falla cerrada; el
costo es operativo.

**Hecho (27-10-2026):** `deps.sii.cerrar()` en un `finally` dentro del bucle.
Cierra el navegador después de cada factura, con éxito o con fallo, así que la
siguiente relanza y vuelve a autenticarse: las condiciones de "de a una", que
nunca fallaron. Cuesta ~20 s de login por factura.

**Esto esquiva el problema, no lo arregla.** El diagnóstico de `5b3171d` (la
alerta del portal y la última URL viajan en el error) sigue puesto para cuando
el fallo reaparezca.

**Falta validarlo, y solo se puede con un lote real.** Las pruebas cubren el
mecanismo (que se cierra después de cada factura y también cuando falla), no
que el lote salga bien: eso no se puede comprobar en frío. La ocasión es el
ciclo del 25 de noviembre, aprobando varias facturas seguidas en vez de de a
una. **No lo pruebes por primera vez ese mismo día sin estar mirando.**

---

## 🟠 6. Apagar Supabase — a medias (27-10-2026)

**Hecho:** borrados los secretos `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`
de GitHub. Nada los leía desde el 15-10 y la service-role key salta todas las
restricciones de la base, así que no tenía por qué seguir ahí.

El riesgo que esta tarea advertía ya no existe: los cuatro workflows exigen
`CF_API_URL` antes de hacer nada, así que sin credenciales de Cloudflare el
agente no opera — nunca cae a un SQLite vacío ni a una copia vieja.

**Falta:**

- Comparar `invoice_runs` de Supabase contra D1 (36 filas, última escritura
  2026-10-27). El 27-10 Supabase dio timeout en tres intentos pese a figurar
  `ACTIVE_HEALTHY`; hay que despertarlo abriéndolo en el panel.
- Recién con esa comparación en mano: pausar o eliminar el proyecto.
- Borrar `.github/workflows/migrar-pdfs-r2.yml`. Era la migración única de
  PDFs y ya no puede correr sin los secretos, pero **se deja hasta que la
  comparación confirme que no quedó ningún PDF sin migrar**: si quedara, esa
  es la herramienta para traerlo.

---

## Resueltas

*Se dejan por un tiempo: explican por qué el código quedó como quedó.*

---

## ✅ 0. Workflow para cancelar una factura preparada — HECHA (26-10-2026)

`.github/workflows/cancelar.yml`: disparo solo manual, entradas por entorno y
validadas, exige `CF_API_TOKEN` además de la URL. Estrenado en producción
cancelando `RECURRENT:EMP-001:CLI-031:2026-10` (cliente desactivado en el
Excel después de prepararla).

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

## ✅ 2. El token de aprobación se rompía con acentos — ARREGLADA (26-10-2026)

Arreglado en `cloudflare/src/index.ts`: el cuerpo del token se convierte a
bytes y se decodifica con `TextDecoder` (UTF-8), que es lo que escribió el
firmante en Node. La prueba nueva en `tests/cloudflare/worker.test.ts` usa un
`factura_id` con tilde y **falla sin el arreglo** (404, "Factura no
encontrada"), así que no puede volver a romperse en silencio.

**Desplegado** el 28-10-2026 (versión `a4063589`), junto con el resto de los
cambios del Worker. Verificado leyendo el código desplegado desde Cloudflare.


---

## ✅ 2b. Despliegue del Worker desde Actions — HECHA (26-10-2026)

`.github/workflows/deploy-worker.yml`: disparo **solo manual**, mismo patrón
que `cancelar.yml` (termina sin ruido si falta `CLOUDFLARE_API_TOKEN`) y
grupo `facturacion-sii`, que es la guarda contra desplegar a mitad de una
emisión: espera a que termine. Instala wrangler con `npm ci` desde
`cloudflare/package-lock.json` y corre `wrangler deploy` en `cloudflare/`.
No aplica migraciones de D1.

**Pendiente del operador:** crear el token en Cloudflare (plantilla *Edit
Cloudflare Workers*) y guardarlo como secreto `CLOUDFLARE_API_TOKEN`; mientras
no exista, el workflow termina sin hacer nada.

**Mientras tanto, el 28-10-2026 se desplegó a mano** (`npx wrangler deploy`
desde `cloudflare/`, versión `a4063589`, con el árbol limpio en `main`). El
Worker en producción ya tiene 2, 3, M3, M4, B1, B5, B3 y `/cliente-nuevo`;
se verificó leyendo el código desplegado: `COMANDOS` incluye `/cliente-nuevo`.

---

## ✅ 3. El PDF se subía con una comprobación no atómica — ARREGLADA (26-10-2026)

`cloudflare/src/index.ts`: el `PUT /api/pdf` ya no hace `head` y después `put`;
pasa `onlyIf: { etagDoesNotMatch: '*' }` en el mismo `put` y R2 devuelve `null`
si la clave existe, que se traduce en el 409 `YA_EXISTE` de siempre. La
interfaz `R2Bucket` y el R2 falso de las pruebas entienden `onlyIf`. La prueba
nueva anula `head` (simula la ventana de carrera) y exige que la segunda subida
igual sea rechazada y el PDF original quede intacto.

---

## ✅ 5. Media credencial desviaba la escritura sin avisar — ARREGLADA (26-10-2026)

`src/cli/entorno.ts`: si está presente *cualquiera* de `CF_API_URL`/`CF_API_TOKEN`
se exigen ambas y, si falta una, el agente **lanza** nombrándola; igual para el
par de Supabase. Supabase dejó de ser plan B por omisión: solo se activa con
`AGENTE_MODO=supabase` explícito, y tener sus credenciales sin las de
Cloudflare es un error, no un modo. Los gates de `emit-approved` y
`solicitudes` y la verificación de `prepare-notify` y `cancelar` distinguen
"sin configurar" (aviso y nada que hacer) de "media credencial" (`::error::`).
Pruebas en `tests/cli/entorno.test.ts`.

---

## ✅ 7. Arreglos menores de la revisión — CERRADA (27-10-2026)

| | Qué quedó |
|---|---|
| M2 | `ApiCloudflare` tiene timeout (`AbortSignal.timeout`, 30 s) y reintento acotado (3 intentos) reutilizando `conReintentos` de Graph: red, timeout y 5xx se reintentan; cualquier 4xx (el 409 del CAS, `YA_EXISTE`, `FACTURA_DUPLICADA`) es respuesta y no se repite. `ErrorApiCloudflare` hereda de `HttpError` para eso. Pruebas en `tests/store/api-cloudflare.test.ts` |
| M3 | Un `expiraEn` no parseable (NaN) ya no es "nunca vence": tanto el Worker como el firmante en Node lo rechazan como token inválido (vencimiento). Pruebas en `tests/services/token-aprobacion.test.ts` y `tests/cloudflare/worker.test.ts` |
| M4 | El Worker valida la entrada de `crear-factura` (`payload` texto JSON con `factura_id` y `lineas` no vacías, `hash`) y responde 400 con el motivo en vez de 500; lo mismo para un cuerpo que no es JSON en las rutas `/api/*` y para una clave de PDF inválida. Prueba en `tests/cloudflare/worker.test.ts` |
| B1 | El mensaje crudo de D1 ya no se responde al chat de Telegram: el chat recibe un aviso genérico y el detalle queda en el log del Worker (`console.error`). Prueba en `tests/cloudflare/worker.test.ts` |
| B4 | `migrar-pdfs-r2.yml` lleva `concurrency: facturacion-sii` como los otros cinco workflows |
| B5 | Todo el HTML de `/aprobar` sale con `Cache-Control: no-store` (verificado en la prueba de aprobación) |
| N1 | `abrirYPreparar` reintenta hasta 3 veces (5 s, 10 s) la navegación login → empresa → formulario cuando el navegador reporta un corte de conexión (`net::ERR_CONNECTION_RESET` y afines). Solo eso: cualquier otro error se propaga al primer intento, y el tramo posterior a la firma no cambia. Política en `src/adapters/sii/reintento-red.ts`, probada en `tests/adapters/reintento-red.test.ts` |
| N3 | El preflight solo exige la clave del SII cuando el comando va a abrir el portal (`verificarSecretoSii`, que `conEntorno` toma de `usaSii`). `prepare`, `notify`, `procesar-solicitudes`, `retry-email` y `cancel` pasan `usaSii: false`, y los workflows `prepare-notify`, `solicitudes` y `cancelar` dejaron de recibir `SII_CLAVE`/`SII_CLAVE_FIRMA`; solo `emit-approved` las tiene. Prueba en `tests/config/preflight.test.ts` |
| N2 | `rutaRaizClientes` dejó de guardarse como ruta absoluta. `cargarConfig` la resuelve en cada carga contra la raíz del proyecto: ausente o relativa apunta a `<raíz>/cliente`, y una absoluta ya configurada se respeta. `setup` ya no la graba. Mover la carpeta del repo ya no rompe los comandos locales en el preflight. Pruebas en `tests/config/config.test.ts` |
| B3 | `/aprobar` ya no escribe en el GET: muestra la factura y un botón, y la aprobación la registra el POST que envía ese botón (token en el formulario). Un escáner de enlaces que haga prefetch no aprueba nada. Las validaciones (firma, vencimiento, estado, hash) corren igual en ambos. Prueba: dos GET seguidos no dejan aprobación y el POST sí |

---

## ✅ 8. Octubre — CERRADO (26-10-2026)

9 emitidas (CLI-021, 022, 023, 024, 025, 027, 028, 029, 030) y 1 cancelada
(CLI-031, cliente desactivado). Verificado contra el RCV oficial: 9 facturas,
ninguna de más.

Se emitió **de a una** porque la tarea 4 sigue abierta. Dos facturas fallaron
con `ERR_CONNECTION_RESET` del portal antes de firmar y salieron al reintentar
(ver N1 en la tarea 7).

**Próximo lote: 25 de noviembre.**

---

## ✅ 9. Pendiente de agosto — CERRADO (27-10-2026)

El **PDF del folio 42** (DISUADE SPA) nunca le llegó al cliente: la factura se
emitió bien ante el SII, pero quedó en `REQUIERE_REVISION` porque el agente no
supo leer el folio. Fue el caso que destapó el bug del parser.

El operador regularizó a DISUADE a mano. No quedan documentos pendientes de
entrega.

La fila de `RECURRENT:EMP-001:CLI-029:2026-08` **sigue en `REQUIERE_REVISION` y
así debe quedarse**: es estado terminal y es el registro de que ese día algo
salió mal. No bloquea nada — el gate de emisión solo mira `APROBADA`.

---

## ✅ 10. CI en cada push — HECHA (28-10-2026)

Ningún workflow validaba nada en push: había 331 pruebas y cuatro chequeos, y
la única garantía era que quien commiteara se acordara de correrlos. Frágil
justamente porque a este repo le escriben agentes autónomos.

`.github/workflows/ci.yml`: en cada push a `main` y en cada pull request, un
solo job corre `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
**Sin secretos** (las pruebas jamás tocan el SII ni envían correos) y **fuera
del grupo `facturacion-sii`**: un CI que espere o bloquee una emisión real es
peor que no tener CI. Tiene su propio grupo por rama.

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
