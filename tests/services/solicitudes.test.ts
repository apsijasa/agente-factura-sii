// tests/services/solicitudes.test.ts
import { describe, expect, it } from 'vitest';
import { parsearSolicitudFactura, resolverCliente } from '../../src/services/solicitudes.js';
import type { Cliente } from '../../src/domain/tipos.js';

describe('parsearSolicitudFactura', () => {
  it('parsea el caso simple: cliente, monto CLP entero y glosa', () => {
    const s = parsearSolicitudFactura('/factura CLI-022 250000 Asesoría contable julio');
    expect(s).toEqual({
      clienteTexto: 'CLI-022',
      moneda: 'CLP',
      monto: 250000,
      glosa: 'Asesoría contable julio',
    });
  });

  it('acepta montos CLP con $ y puntos de miles', () => {
    const s = parsearSolicitudFactura('/factura CLI-022 $1.250.000 Proyecto especial');
    expect(s.monto).toBe(1250000);
    expect(s.moneda).toBe('CLP');
  });

  it('acepta montos en UF con coma o punto decimal', () => {
    expect(parsearSolicitudFactura('/factura CLI-025 33,5UF Consultoría').monto).toBe(33.5);
    expect(parsearSolicitudFactura('/factura CLI-025 33.5uf Consultoría').moneda).toBe('UF');
  });

  it('acepta el cliente entre comillas (nombres con espacios)', () => {
    const s = parsearSolicitudFactura('/factura "SOCIEDAD PM" 250000 Asesoría del mes');
    expect(s.clienteTexto).toBe('SOCIEDAD PM');
    expect(s.glosa).toBe('Asesoría del mes');
  });

  it('rechaza CLP con decimales', () => {
    expect(() => parsearSolicitudFactura('/factura CLI-022 2500,5 Asesoría')).toThrow(/entero/i);
  });

  it('rechaza cuando falta la glosa', () => {
    expect(() => parsearSolicitudFactura('/factura CLI-022 250000')).toThrow(/descripci/i);
  });

  it('rechaza cuando el monto no es numérico o no es positivo', () => {
    expect(() => parsearSolicitudFactura('/factura CLI-022 abc Asesoría')).toThrow(/monto/i);
    expect(() => parsearSolicitudFactura('/factura CLI-022 0 Asesoría')).toThrow(/monto/i);
  });

  it('rechaza un mensaje que no es /factura', () => {
    expect(() => parsearSolicitudFactura('hola')).toThrow(/\/factura/);
  });
});

const clientes: Cliente[] = [
  {
    cliente_id: 'CLI-022', razon_social: 'SOCIEDAD PM SPA', nombre_carpeta: 'SOCIEDAD PM',
    rut_cliente: '78264318-5', email_facturacion: 'pm@cliente.cl', giro: 'Servicios',
    direccion: 'Calle 1', comuna: 'Las Condes', ciudad: 'Santiago', activo: true,
  },
  {
    cliente_id: 'CLI-025', razon_social: 'NATURATERRA PROPIEDADES Y ASOCIADOS', nombre_carpeta: 'NATURATERRA',
    rut_cliente: '76903427-7', email_facturacion: 'nt@cliente.cl', giro: 'Propiedades',
    direccion: 'Calle 2', comuna: 'Las Condes', ciudad: 'Santiago', activo: true,
  },
  {
    cliente_id: 'CLI-031', razon_social: 'SOCIEDAD MMP', nombre_carpeta: 'SOCIEDAD MMP',
    rut_cliente: '78282757-K', email_facturacion: 'mmp@cliente.cl', giro: 'Servicios',
    direccion: 'Calle 3', comuna: 'Las Condes', ciudad: 'Santiago', activo: true,
  },
  {
    cliente_id: 'CLI-099', razon_social: 'INACTIVA SPA', nombre_carpeta: 'INACTIVA',
    rut_cliente: '76123456-0', email_facturacion: 'x@x.cl', giro: 'X',
    direccion: '', comuna: '', ciudad: '', activo: false,
  },
];

describe('resolverCliente', () => {
  it('resuelve por cliente_id exacto (sin importar mayúsculas)', () => {
    expect(resolverCliente(clientes, 'cli-022')?.razon_social).toBe('SOCIEDAD PM SPA');
  });

  it('resuelve por fragmento único de la razón social', () => {
    expect(resolverCliente(clientes, 'naturaterra')?.cliente_id).toBe('CLI-025');
  });

  it('rechaza fragmentos ambiguos listando los candidatos', () => {
    expect(() => resolverCliente(clientes, 'sociedad')).toThrow(/ambiguo|SOCIEDAD PM/i);
  });

  it('rechaza clientes inexistentes con mensaje claro', () => {
    expect(() => resolverCliente(clientes, 'CLI-777')).toThrow(/no encontr/i);
  });

  it('excluye a los clientes inactivos', () => {
    expect(() => resolverCliente(clientes, 'INACTIVA')).toThrow(/no encontr/i);
  });
});
