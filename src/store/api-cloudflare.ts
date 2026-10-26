// src/store/api-cloudflare.ts
// Cliente HTTP de la API privada del Worker (cloudflare/src/index.ts), que
// reemplaza al cliente de Supabase en modo nube. Toda llamada lleva el
// Bearer AGENT_API_TOKEN; el Worker es el único que toca D1 y R2.
import { conReintentos, HTTP_TIMEOUT_MS, HttpError } from '../adapters/graph/reintentos.js';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface OpcionesApiCloudflare {
  timeoutMs: number;
  intentos: number;
  baseMs: number;
}

// Sin timeout, un fetch colgado en `guardarFolio` dejaba el folio vivo solo en
// state_events.detalle. Reintentar es seguro porque cada ruta tolera una
// segunda aplicación: los UPDATE son idempotentes, crear-factura y el CAS de
// registrar-transicion responden 409 si la primera llegó (y eso no se
// reintenta), y el PUT del PDF es "nunca sobrescribe". Nada roza el invariante
// de una sola emisión, que protege el clic de firma y no estas escrituras.
const OPCIONES_PREDETERMINADAS: OpcionesApiCloudflare = { timeoutMs: HTTP_TIMEOUT_MS, intentos: 3, baseMs: 500 };

// Hereda de HttpError para que `conReintentos` aplique su política: 429 y 5xx
// se reintentan; cualquier otro 4xx es una respuesta del Worker, no una falla.
export class ErrorApiCloudflare extends HttpError {
  readonly estado: number;

  constructor(
    mensaje: string,
    estado: number,
    readonly codigo?: string,
  ) {
    super(estado, mensaje);
    this.name = 'ErrorApiCloudflare';
    this.estado = estado;
  }
}

export class ApiCloudflare {
  private readonly base: string;
  private readonly opciones: OpcionesApiCloudflare;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: Fetch = (url, init) => fetch(url, init),
    opciones: Partial<OpcionesApiCloudflare> = {},
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.opciones = { ...OPCIONES_PREDETERMINADAS, ...opciones };
  }

  private async llamar(ruta: string, init: RequestInit = {}): Promise<Response> {
    const { timeoutMs, intentos, baseMs } = this.opciones;
    return conReintentos(async () => {
      const res = await this.fetchImpl(`${this.base}${ruta}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw await this.errorDeRespuesta(ruta, res);
      return res;
    }, { intentos, baseMs });
  }

  private async errorDeRespuesta(ruta: string, res: Response): Promise<ErrorApiCloudflare> {
    let codigo: string | undefined;
    try {
      codigo = ((await res.json()) as { error?: string }).error;
    } catch {
      codigo = undefined;
    }
    return new ErrorApiCloudflare(`Cloudflare ${ruta}: HTTP ${res.status}${codigo ? ` ${codigo}` : ''}`, res.status, codigo);
  }

  private async postJson<T>(ruta: string, cuerpo: unknown): Promise<T> {
    const res = await this.llamar(ruta, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
    });
    return (await res.json()) as T;
  }

  /** Consulta parametrizada contra D1 (placeholders `?`). */
  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{ results: T[]; changes: number }> {
    return this.postJson('/api/query', { sql, params });
  }

  async crearFactura(payload: string, hash: string): Promise<void> {
    await this.postJson('/api/crear-factura', { payload, hash });
  }

  async registrarTransicion(facturaId: string, desde: string, hacia: string, detalle: string): Promise<void> {
    await this.postJson('/api/registrar-transicion', { factura_id: facturaId, desde, hacia, detalle });
  }

  async subirPdf(clave: string, datos: Buffer): Promise<void> {
    await this.llamar(`/api/pdf?key=${encodeURIComponent(clave)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body: new Uint8Array(datos),
    });
  }

  async descargarPdf(clave: string): Promise<Buffer> {
    const res = await this.llamar(`/api/pdf?key=${encodeURIComponent(clave)}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
