// tests/store/supabase-falso.ts
// Cliente Supabase falso EN MEMORIA, fiel a la semántica del esquema real:
// reproduce las tablas de auditoría y las RPC crear_factura / registrar_transicion
// (incluido el compare-and-swap y el error FACTURA_DUPLICADA) para que la suite
// de contrato pueda ejercitar AuditStoreSupabase con el mismo comportamiento
// observable que Postgres. No es un mock de llamadas: mantiene estado.
import type { SupabaseClient } from '@supabase/supabase-js';

type Fila = Record<string, unknown>;
type Resultado = { data: unknown; error: { message: string } | null };

interface Tablas {
  invoice_runs: Fila[];
  invoice_lines: Fila[];
  state_events: Fila[];
  approvals: Fila[];
  email_attempts: Fila[];
}

export function crearSupabaseFalso(): { sb: SupabaseClient; tablas: Tablas } {
  const tablas: Tablas = {
    invoice_runs: [],
    invoice_lines: [],
    state_events: [],
    approvals: [],
    email_attempts: [],
  };
  let secuencia = 0;

  const rpc = async (nombre: string, args: Record<string, string>): Promise<{ error: { message: string } | null }> => {
    if (nombre === 'crear_factura') {
      const payload = JSON.parse(args.p_payload as string) as {
        factura_id: string;
        lineas: Record<string, unknown>[];
      };
      if (tablas.invoice_runs.some((r) => r.factura_id === payload.factura_id)) {
        return { error: { message: 'FACTURA_DUPLICADA' } };
      }
      tablas.invoice_runs.push({
        factura_id: payload.factura_id,
        estado: 'BORRADOR',
        payload_json: args.p_payload,
        payload_hash: args.p_hash,
        folio_sii: null,
        pdf_path: null,
      });
      for (const l of payload.lineas) {
        tablas.invoice_lines.push({ factura_id: payload.factura_id, ...l });
      }
      tablas.state_events.push({
        id: ++secuencia,
        factura_id: payload.factura_id,
        desde: null,
        hacia: 'BORRADOR',
        detalle: 'creación',
        creado_en: new Date().toISOString(),
      });
      return { error: null };
    }
    if (nombre === 'registrar_transicion') {
      const fila = tablas.invoice_runs.find(
        (r) => r.factura_id === args.p_factura_id && r.estado === args.p_desde,
      );
      if (!fila) return { error: { message: 'TRANSICION_CONCURRENTE' } };
      fila.estado = args.p_hacia;
      tablas.state_events.push({
        id: ++secuencia,
        factura_id: args.p_factura_id,
        desde: args.p_desde,
        hacia: args.p_hacia,
        detalle: args.p_detalle,
        creado_en: new Date().toISOString(),
      });
      return { error: null };
    }
    return { error: { message: `RPC desconocida: ${nombre}` } };
  };

  const from = (tabla: keyof Tablas) => {
    const consulta = (filtros: [string, unknown][]) => {
      const filas = () => tablas[tabla].filter((f) => filtros.every(([c, v]) => f[c] === v));
      const b = {
        eq(col: string, val: unknown) {
          return consulta([...filtros, [col, val]]);
        },
        select() {
          return b;
        },
        async maybeSingle(): Promise<Resultado> {
          return { data: filas()[0] ?? null, error: null };
        },
        async order(col: string): Promise<Resultado> {
          const orden = [...filas()].sort((a, b2) => {
            const x = a[col] as string | number;
            const y = b2[col] as string | number;
            return x < y ? -1 : x > y ? 1 : 0;
          });
          return { data: orden, error: null };
        },
      };
      return b;
    };
    return {
      select() {
        return consulta([]);
      },
      async insert(fila: Fila) {
        tablas[tabla].push({ id: ++secuencia, ...fila });
        return { error: null };
      },
      async upsert(fila: Fila) {
        const idx = tablas[tabla].findIndex((f) => f.factura_id === fila.factura_id);
        if (idx >= 0) tablas[tabla][idx] = fila;
        else tablas[tabla].push(fila);
        return { error: null };
      },
      update(cambios: Fila) {
        return {
          async eq(col: string, val: unknown) {
            for (const f of tablas[tabla]) {
              if (f[col] === val) Object.assign(f, cambios);
            }
            return { error: null };
          },
        };
      },
    };
  };

  return { sb: { rpc, from } as unknown as SupabaseClient, tablas };
}
