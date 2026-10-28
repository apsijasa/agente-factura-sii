// src/adapters/excel/excel-adapter.ts
import type { IGraphClient } from '../graph/graph-client.js';

export const ENCABEZADOS = {
  tblEmpresas: ['empresa_id', 'rut_emisor', 'razon_social', 'email_remitente', 'email_copia', 'activo'],
  tblClientes: [
    'cliente_id', 'razon_social', 'nombre_carpeta', 'rut_cliente', 'email_facturacion',
    'giro', 'direccion', 'comuna', 'ciudad', 'activo',
  ],
  tblCobrosRecurrentes: [
    'cobro_id', 'empresa_id', 'cliente_id', 'descripcion_servicio', 'moneda', 'monto_neto',
    'cantidad', 'frecuencia', 'dia_emision', 'forma_pago', 'dias_vencimiento',
    'fecha_inicio', 'fecha_fin', 'activo',
  ],
  tblFacturas: [
    'factura_id', 'cobro_id', 'periodo', 'fecha_emision', 'valor_uf', 'monto_neto_clp',
    'iva_clp', 'total_clp', 'folio_sii', 'estado', 'pdf_path', 'aprobada_por',
    'fecha_aprobacion', 'fecha_envio', 'error',
  ],
} as const;

export type NombreTabla = keyof typeof ENCABEZADOS;
export type FilaFacturasExcel = Record<(typeof ENCABEZADOS.tblFacturas)[number], string>;
export type FilaClientesExcel = Record<(typeof ENCABEZADOS.tblClientes)[number], string>;

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

interface FilaGraph {
  index?: number;
  values: string[][];
}

interface PaginaFilas {
  value: FilaGraph[];
  '@odata.nextLink'?: string;
}

export class ExcelAdapter {
  constructor(
    private readonly graph: IGraphClient,
    private readonly cfg: { driveId: string; itemId: string },
  ) {}

  private base(): string {
    return `/drives/${this.cfg.driveId}/items/${this.cfg.itemId}/workbook`;
  }

  private async validarEncabezados(tabla: NombreTabla): Promise<string[]> {
    const esperados = ENCABEZADOS[tabla] as readonly string[];
    const rango = await this.graph.solicitar<{ values: string[][] }>(
      'GET',
      `${this.base()}/tables/${tabla}/headerRowRange`,
    );
    const reales = (rango.values[0] ?? []).map((v) => String(v).trim());
    if (reales.length !== esperados.length || reales.some((v, i) => v !== esperados[i])) {
      throw new Error(
        `Encabezados de ${tabla} no coinciden. Esperados: [${esperados.join(', ')}]. Reales: [${reales.join(', ')}]`,
      );
    }
    return [...esperados];
  }

  /** Lee todas las filas de la tabla siguiendo @odata.nextLink hasta agotar las páginas. */
  private async leerFilas(tabla: NombreTabla): Promise<FilaGraph[]> {
    const acumuladas: FilaGraph[] = [];
    let ruta: string | undefined = `${this.base()}/tables/${tabla}/rows`;
    while (ruta !== undefined) {
      const pagina: PaginaFilas = await this.graph.solicitar<PaginaFilas>('GET', ruta);
      acumuladas.push(...pagina.value);
      const enlace = pagina['@odata.nextLink'];
      // El nextLink de Graph es absoluto; GraphClient antepone la base, así que se quita aquí.
      ruta =
        enlace === undefined
          ? undefined
          : enlace.startsWith(GRAPH_BASE)
            ? enlace.slice(GRAPH_BASE.length)
            : enlace;
    }
    return acumuladas;
  }

  async leerTabla(tabla: string): Promise<Record<string, string>[]> {
    if (!(tabla in ENCABEZADOS)) throw new Error(`Nombre de tabla no autorizado: ${tabla}`);
    const nombre = tabla as NombreTabla;
    const encabezados = await this.validarEncabezados(nombre);
    const filas = await this.leerFilas(nombre);
    return filas.map((fila) => {
      const valores = fila.values[0] ?? [];
      const objeto: Record<string, string> = {};
      encabezados.forEach((clave, i) => {
        objeto[clave] = valores[i] === undefined || valores[i] === null ? '' : String(valores[i]);
      });
      return objeto;
    });
  }

  async agregarFilaFacturas(fila: FilaFacturasExcel): Promise<void> {
    const valores = ENCABEZADOS.tblFacturas.map((clave) => fila[clave] ?? '');
    await this.graph.solicitar('POST', `${this.base()}/tables/tblFacturas/rows/add`, {
      values: [valores],
    });
  }

  /** Alta de un cliente puntual pedida por Telegram (`/cliente-nuevo`). */
  async agregarFilaClientes(fila: FilaClientesExcel): Promise<void> {
    await this.validarEncabezados('tblClientes');
    const valores = ENCABEZADOS.tblClientes.map((clave) => fila[clave] ?? '');
    await this.graph.solicitar('POST', `${this.base()}/tables/tblClientes/rows/add`, {
      values: [valores],
    });
  }

  async actualizarFilaFacturas(facturaId: string, cambios: Partial<FilaFacturasExcel>): Promise<void> {
    await this.validarEncabezados('tblFacturas');
    const filas = await this.leerFilas('tblFacturas');
    const fila = filas.find((f) => (f.values[0] ?? [])[0] === facturaId);
    if (!fila) throw new Error(`Fila no encontrada en tblFacturas: ${facturaId}`);
    if (fila.index === undefined) {
      throw new Error(`La fila de ${facturaId} en tblFacturas no trae índice de Graph`);
    }
    const rutaFila = `${this.base()}/tables/tblFacturas/rows/itemAt(index=${fila.index})`;
    // Relectura inmediata antes del PATCH: la fila pudo moverse o cambiar entre lecturas.
    const releida = await this.graph.solicitar<FilaGraph>('GET', rutaFila);
    const actuales = (releida.values[0] ?? []).map((v) => (v == null ? '' : String(v)));
    if (actuales[0] !== facturaId) {
      throw new Error(
        `La fila con índice ${fila.index} de tblFacturas cambió de forma concurrente: ` +
          `se esperaba ${facturaId} y ahora contiene ${actuales[0] ?? '(vacío)'}`,
      );
    }
    ENCABEZADOS.tblFacturas.forEach((clave, i) => {
      if (cambios[clave] !== undefined) actuales[i] = cambios[clave] as string;
    });
    await this.graph.solicitar('PATCH', rutaFila, { values: [actuales] });
  }
}
