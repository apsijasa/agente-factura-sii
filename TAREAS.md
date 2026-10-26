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
| **2b** | Necesita un `CLOUDFLARE_API_TOKEN` que hay que crear a mano, y hay que decidir la guarda: desplegar el Worker a mitad de un ciclo de emisión no es inocuo |
| **4** | Sin causa raíz. El arreglo propuesto es un rodeo y **solo se valida con un lote real**; no hay forma de comprobarlo en frío |
| **6** | Borra secretos y pausa un proyecto. Irreversible, y depende de que la 5 esté verificada en producción |
| **9** | No es código: es entrar al portal del SII y enviarle un documento a un cliente |
| **N2** | Es `.data/config.json`, archivo local de la máquina del operador y fuera de git |

El resto (3, 5, y M2–M4, B1, B4, B5, N1, N3 de la tarea 7) sí se puede tomar de
corrido, siempre con los cuatro chequeos en verde antes de cada commit.

---

## 🟠 2b. El Worker no tiene despliegue automatizado

Salió a la luz al arreglar la tarea 2: el código del Worker vive en el repo,
pero **un `git push` no lo despliega**. Hay que correr `wrangler deploy` a mano
desde `cloudflare/`, y no existe ningún workflow que lo haga.

Eso significa que el repo y lo que corre en producción **pueden divergir en
silencio**, sin que nada lo avise. Es la misma clase de problema que tenía el
esquema de Supabase antes de la migración, y la razón por la que un arreglo
puede quedar "listo" en `main` sin estar vivo.

**Qué hacer:** un workflow que despliegue el Worker (`wrangler deploy` con un
`CLOUDFLARE_API_TOKEN` en secretos), con disparo manual como mínimo. Si se hace
automático al tocar `cloudflare/**`, hay que pensar bien la guarda: desplegar
el Worker a mitad de un ciclo de emisión no es inocuo.

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
| M4 | `crearFactura` del Worker no valida la entrada: sin `lineas` revienta con 500 en vez de 400 | `cloudflare/src/index.ts:244-248` |
| B1 | El error crudo de D1 se responde al chat de Telegram | `cloudflare/src/index.ts:217` |
| B3 | `/aprobar` es un GET con efecto de escritura. Mitigado en Telegram y WhatsApp, queda expuesto el canal de correo: un escáner que haga prefetch registraría la aprobación. Preexistente. Cierre: GET muestra botón, POST confirma | `cloudflare/src/index.ts` |
| B4 | `migrar-pdfs-r2.yml` es el único workflow sin `concurrency: facturacion-sii` | `.github/workflows/` |
| B5 | Falta `Cache-Control: no-store` en el HTML de `/aprobar` | `cloudflare/src/index.ts:108-118` |
| N1 | **Reintento acotado ante corte de red antes de firmar.** El 26-10 el portal del SII cortó la conexión dos veces al navegar a `mipeSelEmpresa.cgi` (`net::ERR_CONNECTION_RESET`), en CLI-022 y CLI-027. Ambas se resolvieron reintentando a mano. Ocurre en `abrirYPreparar`, **antes de llenar el formulario y mucho antes de firmar**, así que no deja documento y reintentar es seguro — no roza el invariante de "una sola emisión", que protege el tramo *posterior* al clic de firma. Un reintento acotado (2 o 3 intentos con espera) ahorraría repetir el ciclo completo | `src/adapters/sii/sii-adapter.ts` (`abrirYPreparar`) |
| N2 | `.data/config.json` apunta a `Documents/Codex/agente factura sii/cliente`, la ruta anterior del repo. En modo nube no molesta (la comprobación se salta), pero **cualquier comando local falla en el preflight** | `.data/config.json` → `rutaRaizClientes` |
| N3 | **El preflight exige la clave del SII a comandos que nunca abren el portal.** `preflight` llama a `leerSecreto(rutEmisor)` sin condición, así que `cancel`, `notify`, `retry-email` y `procesar-solicitudes` necesitan `SII_CLAVE` solo para pasar el chequeo. Obliga a repartir la credencial más importante del sistema a workflows que no la usan. Debería verificarse solo cuando el comando vaya a tocar el SII, con una opción como la que ya existe para `verificarRutaClientes` | `src/config/preflight.ts:44-47` |

---

## 🔵 9. Pendiente de agosto sin cerrar

El **PDF del folio 42** (DISUADE SPA) nunca le llegó al cliente. La factura se
emitió bien y es válida, pero quedó en `REQUIERE_REVISION` porque el agente no
supo leer el folio — fue el caso que destapó el bug del parser.

Hay que bajarlo del portal del SII y enviarlo a mano. No requiere código.

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

**Pendiente:** el arreglo no llega a producción hasta correr `wrangler deploy`
desde `cloudflare/` (ver tarea 2b).


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

## ✅ 7. Arreglos menores de la revisión — ítems resueltos

| | Qué quedó |
|---|---|
| M2 | `ApiCloudflare` tiene timeout (`AbortSignal.timeout`, 30 s) y reintento acotado (3 intentos) reutilizando `conReintentos` de Graph: red, timeout y 5xx se reintentan; cualquier 4xx (el 409 del CAS, `YA_EXISTE`, `FACTURA_DUPLICADA`) es respuesta y no se repite. `ErrorApiCloudflare` hereda de `HttpError` para eso. Pruebas en `tests/store/api-cloudflare.test.ts` |
| M3 | Un `expiraEn` no parseable (NaN) ya no es "nunca vence": tanto el Worker como el firmante en Node lo rechazan como token inválido (vencimiento). Pruebas en `tests/services/token-aprobacion.test.ts` y `tests/cloudflare/worker.test.ts` |

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
