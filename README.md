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

## Calidad

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## Seguridad

- Modo predeterminado: simulación. No existen rutas implícitas hacia emisión real.
- Credencial SII en el llavero de macOS; token Graph en cache local fuera de Git.
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
