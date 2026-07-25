# Agente de Facturación SII

CLI local (macOS) que emite facturas electrónicas en el Sistema de Facturación
Gratuito del SII a partir de cobros recurrentes definidos en un libro Excel de
OneDrive, con aprobación humana obligatoria antes de cada emisión.

**Estado: operativo.** Validado contra el portal real del SII en julio 2026
(emisor CTA CONSULTORES), incluida una emisión real completa (folio 35,
24-07-2026). Todo el flujo del portal está calibrado con evidencia de las
páginas reales.

## Qué hace en cada ciclo

1. Lee empresas, clientes y cobros recurrentes desde el Excel de OneDrive
   (Microsoft Graph, sesión cifrada persistente — sin logins repetidos).
2. Valida todo (RUTs módulo 11, fechas de calendario, montos, correos) y agrupa
   los cobros del día en una factura por cliente.
3. Para cobros en UF, obtiene el valor oficial de la UF del día desde sii.cl y
   registra su procedencia en la auditoría.
4. Entra al SII solo: login con RUT/clave (llavero), selección de la empresa
   emisora por RUT, formulario completo, validación.
5. Compara los totales que calcula el SII con los esperados — deben ser
   idénticos al peso.
6. Muestra el resumen y espera la aprobación humana: el texto exacto
   `APROBAR <factura_id>`. **Este paso nunca se automatiza.**
7. Firma el documento (clave de firma desde el llavero), captura el folio,
   descarga el PDF y lo archiva en `cliente/<carpeta>/<AAAA>/<MM>/`.
8. Envía el PDF por correo al cliente (con copia configurada) desde el alias.
9. Registra cada transición en SQLite y refleja el resultado en `tblFacturas`.

## Comandos

| Comando | Efecto |
|---|---|
| `pnpm agent setup` | Asistente de configuración inicial (crea `.data/config.json`) |
| `pnpm agent prepare --mode simulation [--date AAAA-MM-DD]` | Prepara las facturas del día; no toca el SII ni envía correos |
| `pnpm agent preview-sii --invoice <factura_id>` | Ensayo real en el SII: llena y valida, compara totales y se detiene antes de firmar |
| `pnpm agent emit --invoice <factura_id>` | Emisión real; exige `APROBAR <factura_id>` |
| `pnpm agent retry-email --invoice <factura_id>` | Reintenta solo el correo de una factura ya emitida; nunca vuelve a emitir |
| `pnpm agent cancel --invoice <factura_id> --motivo "<texto>"` | Cancela una factura preparada que no se emitirá por el agente (p. ej. emitida a mano en el portal); solo antes de emitir |
| `pnpm agent test-email` | Correo `[PRUEBA]` desde el alias al buzón principal (verificación del alias) |

Todos se ejecutan desde la carpeta del proyecto. Documentación:

- **[docs/manual-de-usuario.md](docs/manual-de-usuario.md)** — guía completa paso a paso (configurar + usar), para el operador
- [docs/setup.md](docs/setup.md) — configuración inicial (referencia técnica)
- [docs/operacion.md](docs/operacion.md) — ciclo mensual, referencia del Excel y solución de problemas

## Seguridad

- **Modo predeterminado: simulación.** No existen rutas implícitas hacia
  emisión real; `emit` es el único camino y pasa por la aprobación.
- **La aprobación va ligada al contenido exacto** (hash SHA-256 del payload):
  si cualquier dato cambia entre la preparación y la emisión, se invalida.
- **Una sola acción de emisión, jamás reintentos**: ante una respuesta incierta
  del SII la factura queda en `REQUIERE_REVISION` y ninguna ruta automática
  puede volver a emitirla. Un folio confirmado nunca se pierde, aunque falle la
  descarga del PDF o el correo.
- **Secretos solo en el llavero de macOS**: clave del SII (cuenta
  `<empresa_id>`), clave de firma (cuenta `<empresa_id>-firma`) y la llave del
  cache de tokens Microsoft (`msal-cache-key`). Nada en código, Excel, Git ni
  logs (logger con redacción de RUTs, correos y tokens).
- El navegador del SII es **visible**: cualquier verificación extraordinaria
  del portal (captcha, segundo factor) la resuelve el operador; el agente no
  evade controles de seguridad.
- Evidencia de cada sesión SII (capturas + HTML) en `.data/evidence`, local.

## Recuperación

- Proceso caído en plena emisión → la factura huérfana en `EMITIENDO` pasa a
  `REQUIERE_REVISION` automáticamente al iniciar cualquier comando.
- Ante `REQUIERE_REVISION`: **verificar primero en el SII** (documentos
  emitidos) si el documento existe, antes de cualquier acción manual.
- Correo fallido → `ERROR_REINTENTABLE`; se resuelve con `retry-email`,
  conservando folio y PDF.

## Calidad

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Suite de 169 pruebas (dominio tributario, adaptadores, integración simulada);
las pruebas automáticas jamás tocan el SII real ni envían correos.
