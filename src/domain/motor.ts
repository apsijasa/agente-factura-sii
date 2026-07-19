// src/domain/motor.ts
import type { GrupoFacturable } from './agrupacion.js';
import { lineaClp, lineaUf, totalesEsperados } from './dinero.js';
import { fechaVencimiento } from './fechas.js';
import type { Cliente, Empresa, InvoicePayload, LineaFactura } from './tipos.js';
import { parsearDestinatarios } from './validacion.js';

export interface ClasificacionEmisor {
  tipoVenta: string;
  tipoCompra: string;
}

export function construirPayload(
  grupo: GrupoFacturable,
  empresa: Empresa,
  cliente: Cliente,
  clasificacion: ClasificacionEmisor,
  valorUf: number | null,
): InvoicePayload {
  const formasPago = new Set(grupo.cobros.map((c) => c.forma_pago));
  if (formasPago.size > 1) {
    throw new Error(`forma_pago inconsistente en el grupo ${grupo.clave}: ${[...formasPago].join(', ')}`);
  }
  const diasVencimiento = new Set(grupo.cobros.map((c) => c.dias_vencimiento));
  if (diasVencimiento.size > 1) {
    throw new Error(`dias_vencimiento inconsistente en el grupo ${grupo.clave}`);
  }
  const requiereUf = grupo.cobros.some((c) => c.moneda === 'UF');
  if (requiereUf && valorUf === null) {
    throw new Error(`El grupo ${grupo.clave} tiene líneas UF y no hay valor UF; factura bloqueada`);
  }

  const lineas: LineaFactura[] = grupo.cobros.map((c) => {
    const calculo =
      c.moneda === 'CLP'
        ? lineaClp(c.monto_neto, c.cantidad)
        : lineaUf(c.monto_neto, c.cantidad, valorUf as number);
    return {
      cobro_id: c.cobro_id,
      descripcion: c.descripcion_servicio,
      moneda: c.moneda,
      monto_neto_original: c.monto_neto,
      cantidad: c.cantidad,
      precio_unitario_clp: calculo.precioUnitarioClp,
      total_linea_clp: calculo.totalLineaClp,
    };
  });

  const totales = totalesEsperados(lineas.map((l) => l.total_linea_clp));
  const primero = grupo.cobros[0]!;

  return {
    factura_id: grupo.clave,
    empresa_id: empresa.empresa_id,
    rut_emisor: empresa.rut_emisor,
    razon_social_emisor: empresa.razon_social,
    cliente_id: cliente.cliente_id,
    rut_cliente: cliente.rut_cliente,
    razon_social_cliente: cliente.razon_social,
    nombre_carpeta: cliente.nombre_carpeta,
    periodo: grupo.periodo,
    fecha_emision: grupo.fechaProgramada,
    fecha_vencimiento: fechaVencimiento(grupo.fechaProgramada, primero.forma_pago, primero.dias_vencimiento),
    forma_pago: primero.forma_pago,
    tipo_venta: clasificacion.tipoVenta,
    tipo_compra: clasificacion.tipoCompra,
    valor_uf: requiereUf ? valorUf : null,
    lineas,
    neto_clp: totales.netoClp,
    iva_clp: totales.ivaClp,
    total_clp: totales.totalClp,
    remitente: empresa.email_remitente,
    destinatarios: parsearDestinatarios(cliente.email_facturacion),
    copia: parsearDestinatarios(empresa.email_copia),
  };
}
