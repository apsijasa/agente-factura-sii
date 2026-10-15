// src/store/api-cloudflare.ts
// Cliente HTTP de la API privada del Worker (cloudflare/src/index.ts), que
// reemplaza al cliente de Supabase en modo nube. Toda llamada lleva el
// Bearer AGENT_API_TOKEN; el Worker es el único que toca D1 y R2.

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class ErrorApiCloudflare extends Error {
  constructor(
    mensaje: string,
    readonly estado: number,
    readonly codigo?: string,
  ) {
    super(mensaje);
  }
}

export class ApiCloudflare {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: Fetch = (url, init) => fetch(url, init),
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  private async llamar(ruta: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetchImpl(`${this.base}${ruta}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      let codigo: string | undefined;
      try {
        codigo = ((await res.json()) as { error?: string }).error;
      } catch {
        codigo = undefined;
      }
      throw new ErrorApiCloudflare(`Cloudflare ${ruta}: HTTP ${res.status}${codigo ? ` ${codigo}` : ''}`, res.status, codigo);
    }
    return res;
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
