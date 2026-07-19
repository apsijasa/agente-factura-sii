// src/adapters/graph/graph-client.ts
import {
  PublicClientApplication,
  type AuthenticationResult,
} from '@azure/msal-node';
import { conReintentos } from './reintentos.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SCOPES = ['User.Read', 'Files.ReadWrite', 'Mail.Send', 'offline_access'];

export interface IGraphClient {
  solicitar<T>(metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE', ruta: string, cuerpo?: unknown): Promise<T>;
}

export class GraphClient implements IGraphClient {
  constructor(private readonly obtenerToken: () => Promise<string>) {}

  async solicitar<T>(metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE', ruta: string, cuerpo?: unknown): Promise<T> {
    return conReintentos(
      async () => {
        const token = await this.obtenerToken();
        const respuesta = await fetch(`${GRAPH_BASE}${ruta}`, {
          method: metodo,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
        });
        if (!respuesta.ok) {
          const detalle = await respuesta.text();
          // No incluir el token ni encabezados en el error.
          throw new Error(`HTTP ${respuesta.status} en ${metodo} ${ruta}: ${detalle.slice(0, 300)}`);
        }
        if (respuesta.status === 204) return undefined as T;
        return (await respuesta.json()) as T;
      },
      { intentos: 3, baseMs: 500 },
    );
  }
}

export function crearAutenticadorDeviceCode(opciones: {
  tenantId: string;
  clientId: string;
  cachePlugin?: import('@azure/msal-node').ICachePlugin;
}): () => Promise<string> {
  const pca = new PublicClientApplication({
    auth: {
      clientId: opciones.clientId,
      authority: `https://login.microsoftonline.com/${opciones.tenantId}`,
    },
    cache: opciones.cachePlugin ? { cachePlugin: opciones.cachePlugin } : undefined,
  });

  return async () => {
    const cuentas = await pca.getTokenCache().getAllAccounts();
    if (cuentas.length > 0) {
      try {
        const silencioso = await pca.acquireTokenSilent({ account: cuentas[0]!, scopes: SCOPES });
        if (silencioso?.accessToken) return silencioso.accessToken;
      } catch {
        // continúa con device code
      }
    }
    const resultado: AuthenticationResult | null = await pca.acquireTokenByDeviceCode({
      scopes: SCOPES,
      deviceCodeCallback: (info) => {
        // Instrucción para el operador humano; no contiene secretos.
        console.log(info.message);
      },
    });
    if (!resultado?.accessToken) throw new Error('No se pudo obtener token de Microsoft Graph');
    return resultado.accessToken;
  };
}
