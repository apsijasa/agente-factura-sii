// src/domain/tipos.ts
export type Moneda = 'CLP' | 'UF';
export type FormaPago = 'CONTADO' | 'CREDITO';

export type Estado =
  | 'BORRADOR'
  | 'PENDIENTE_APROBACION'
  | 'APROBADA'
  | 'EMITIENDO'
  | 'EMITIDA'
  | 'DESCARGADA'
  | 'ENVIADA'
  | 'ERROR_REINTENTABLE'
  | 'REQUIERE_REVISION'
  | 'CANCELADA';

export interface Empresa {
  empresa_id: string;
  rut_emisor: string;
  razon_social: string;
  email_remitente: string;
  email_copia: string;
  activo: boolean;
}

export interface Cliente {
  cliente_id: string;
  razon_social: string;
  nombre_carpeta: string;
  rut_cliente: string;
  email_facturacion: string;
  giro: string;
  direccion: string;
  comuna: string;
  ciudad: string;
  activo: boolean;
}

export interface CobroRecurrente {
  cobro_id: string;
  empresa_id: string;
  cliente_id: string;
  descripcion_servicio: string;
  moneda: Moneda;
  monto_neto: number;
  cantidad: number;
  frecuencia: 'MENSUAL';
  dia_emision: number;
  forma_pago: FormaPago;
  dias_vencimiento: number;
  fecha_inicio: string;
  fecha_fin: string | null;
  activo: boolean;
}

export interface LineaFactura {
  cobro_id: string;
  descripcion: string;
  moneda: Moneda;
  monto_neto_original: number;
  cantidad: number;
  precio_unitario_clp: number;
  total_linea_clp: number;
}

export interface InvoicePayload {
  factura_id: string; // RECURRENT:<empresa_id>:<cliente_id>:<AAAA-MM>
  empresa_id: string;
  rut_emisor: string;
  razon_social_emisor: string;
  cliente_id: string;
  rut_cliente: string;
  razon_social_cliente: string;
  nombre_carpeta: string;
  giro_cliente: string;
  direccion_cliente: string;
  comuna_cliente: string;
  ciudad_cliente: string;
  periodo: string;
  fecha_emision: string;
  fecha_vencimiento: string;
  forma_pago: FormaPago;
  tipo_venta: string;
  tipo_compra: string;
  valor_uf: number | null;
  lineas: LineaFactura[];
  neto_clp: number;
  iva_clp: number;
  total_clp: number;
  remitente: string;
  destinatarios: string[];
  copia: string[];
}
