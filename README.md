# Agente de Facturación SII

CLI local (macOS) que prepara facturas electrónicas en el Sistema de Facturación
Gratuito del SII a partir de cobros recurrentes en un libro Excel de OneDrive,
con aprobación humana obligatoria antes de emitir.

## Comandos

| Comando | Efecto |
|---|---|
| `pnpm agent setup` | Asistente de configuración (crea `.data/config.json`) |
| `pnpm agent prepare --mode simulation [--date AAAA-MM-DD]` | Prepara facturas en simulación; no abre el SII ni envía correos |
| `pnpm agent preview-sii --invoice <factura_id>` | Completa la factura en el SII y compara totales; se detiene antes de emitir |
| `pnpm agent emit --invoice <factura_id>` | Emisión real: exige `APROBAR <factura_id>` |
| `pnpm agent retry-email --invoice <factura_id>` | Reintenta solo el correo; nunca vuelve a emitir |
| `pnpm agent test-email` | Envía un correo `[PRUEBA]` desde el alias al buzón principal (validación del alias) |

## Autonomía en el SII (calibrado contra el portal real, jul 2026)

Con `rutOperador` en `.data/config.json` y la clave en el llavero, el agente:
inicia sesión en el SII, selecciona la empresa emisora por su RUT (obligatorio,
nunca usa la empresa por defecto de la sesión), verifica que el formulario
pertenezca al emisor esperado, completa receptor/fechas/líneas, valida y compara
los totales del SII con los esperados. Se detiene SIEMPRE antes de "Firmar",
salvo en `emit` con aprobación explícita vigente. Cualquier verificación
adicional del portal (captcha, segundo factor) la resuelve el operador en la
ventana visible: el agente nunca la evade.

## Calidad

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## Seguridad

- Modo predeterminado: simulación. No existen rutas implícitas hacia emisión real.
- Credencial SII en el llavero de macOS; token Graph en `.data/msal-cache.enc`
  cifrado con AES-256-GCM (llave en el llavero, cuenta `msal-cache-key`).
- El agente no evade CAPTCHA ni MFA: el navegador es visible y el operador se autentica.
- Logs con redacción de RUT, correos y tokens. Evidencias en `.data/evidence`.

## Recuperación

Si el proceso cae en plena emisión, la factura queda huérfana en el estado
`EMITIENDO`. Al iniciar cualquier comando siguiente, el agente detecta esas
filas automáticamente y las pasa a `REQUIERE_REVISION` antes de permitir
cualquier otra acción: el resultado real en el SII es desconocido y ninguna
ruta automática puede volver a emitir sobre esa factura.

Ante una factura en `REQUIERE_REVISION`, **verificar primero en el SII**
(sección de documentos emitidos, por RUT del cliente y fecha) si el
documento efectivamente se emitió, antes de tomar cualquier acción manual
sobre la factura o el libro Excel.

Ver `docs/setup.md` para la configuración inicial completa.
