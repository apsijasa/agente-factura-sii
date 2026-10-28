// tests/services/solicitudes.test.ts
import { describe, expect, it } from 'vitest';
import {
  parsearSolicitudCliente,
  parsearSolicitudFactura,
  resolverCliente,
  carpetaDesdeRazonSocial,
  siguienteClienteId,
} from '../../src/services/solicitudes.js';
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

describe('parsearSolicitudCliente', () => {
  it('parsea rut, correo y razón social', () => {
    const s = parsearSolicitudCliente('/cliente-nuevo 78123456-7 pagos@fulano.cl Constructora Fulano SpA');
    expect(s).toEqual({
      rut: '78123456-7',
      email: 'pagos@fulano.cl',
      razonSocial: 'Constructora Fulano SpA',
    });
  });

  it('normaliza el rut con puntos y con K minúscula', () => {
    const s = parsearSolicitudCliente('/cliente-nuevo 77.859.563-k correo@x.cl Empresa X');
    expect(s.rut).toBe('77859563-K');
  });

  // El dígito verificador es la única defensa contra un dedazo: un RUT con
  // DV incorrecto no existe, y el padrón del SII lo rechazaría recién al emitir.
  it('rechaza un rut con dígito verificador equivocado', () => {
    expect(() => parsearSolicitudCliente('/cliente-nuevo 78123456-9 x@y.cl Empresa')).toThrow(/rut/i);
  });

  it('rechaza un correo inválido', () => {
    expect(() => parsearSolicitudCliente('/cliente-nuevo 78123456-7 no-es-correo Empresa')).toThrow(/correo/i);
  });

  it('exige razón social', () => {
    expect(() => parsearSolicitudCliente('/cliente-nuevo 78123456-7 x@y.cl')).toThrow(/raz[óo]n social/i);
  });

  it('no confunde el comando con /factura', () => {
    expect(() => parsearSolicitudCliente('/factura CLI-022 1000 Algo')).toThrow(/cliente-nuevo/);
  });
});

describe('siguienteClienteId', () => {
  it('toma el mayor correlativo y suma uno, conservando el ancho', () => {
    expect(siguienteClienteId(['CLI-021', 'CLI-031', 'CLI-025'])).toBe('CLI-032');
  });

  it('empieza en CLI-001 si la tabla está vacía', () => {
    expect(siguienteClienteId([])).toBe('CLI-001');
  });

  it('ignora identificadores que no siguen el patrón', () => {
    expect(siguienteClienteId(['CLI-007', 'OTRO', 'X-99'])).toBe('CLI-008');
  });
});

// Alimenta la ruta del PDF en R2 (`facturas/<carpeta>/AAAA/MM/...`), que el
// Worker valida rechazando '/' y '..'. Un nombre sin sanear rompería la subida
// después de tener folio, que es el peor momento posible.
describe('carpetaDesdeRazonSocial', () => {
  it('usa la razón social tal cual cuando ya es segura', () => {
    expect(carpetaDesdeRazonSocial('Constructora Fulano SpA')).toBe('Constructora Fulano SpA');
  });

  it('quita las barras', () => {
    expect(carpetaDesdeRazonSocial('Perez / Soto Ltda')).toBe('Perez Soto Ltda');
  });

  it('neutraliza los puntos suspensivos de ruta', () => {
    expect(carpetaDesdeRazonSocial('..Empresa..')).toBe('Empresa');
  });

  it('nunca devuelve vacío', () => {
    expect(carpetaDesdeRazonSocial('///')).toBe('SIN NOMBRE');
  });
});
