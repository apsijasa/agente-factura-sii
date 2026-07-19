// tests/domain/validacion.test.ts
import { describe, expect, it } from 'vitest';
import {
  esquemaCliente,
  esquemaCobro,
  esquemaEmpresa,
  parsearBooleano,
  parsearDestinatarios,
} from '../../src/domain/validacion.js';

const empresaOk = {
  empresa_id: 'E1',
  rut_emisor: '12.345.678-5',
  razon_social: 'Emisora SpA',
  email_remitente: 'facturas@empresa.cl',
  email_copia: 'copia@empresa.cl',
  activo: 'TRUE',
};

const cobroOk = {
  cobro_id: 'C1',
  empresa_id: 'E1',
  cliente_id: 'CL1',
  descripcion_servicio: 'Asesoría mensual',
  moneda: 'UF',
  monto_neto: '33.5',
  cantidad: '1',
  frecuencia: 'MENSUAL',
  dia_emision: '5',
  forma_pago: 'CONTADO',
  dias_vencimiento: '0',
  fecha_inicio: '2026-01-01',
  fecha_fin: '',
  activo: 'TRUE',
};

describe('parsearBooleano', () => {
  it('acepta TRUE/FALSE/1/0/VERDADERO/FALSO sin distinción de mayúsculas', () => {
    expect(parsearBooleano('TRUE')).toBe(true);
    expect(parsearBooleano('falso')).toBe(false);
    expect(parsearBooleano('1')).toBe(true);
  });
  it('rechaza valores desconocidos', () => {
    expect(() => parsearBooleano('quizás')).toThrow(/booleano/);
  });
});

describe('parsearDestinatarios', () => {
  it('separa por punto y coma y recorta espacios', () => {
    expect(parsearDestinatarios('a@x.cl; b@y.cl')).toEqual(['a@x.cl', 'b@y.cl']);
  });
  it('rechaza correos inválidos', () => {
    expect(() => parsearDestinatarios('a@x.cl; no-es-correo')).toThrow(/correo/);
  });
  it('rechaza campo vacío', () => {
    expect(() => parsearDestinatarios('')).toThrow(/correo/);
  });
});

describe('esquemaEmpresa', () => {
  it('normaliza el RUT del emisor y el booleano activo', () => {
    const e = esquemaEmpresa.parse(empresaOk);
    expect(e.rut_emisor).toBe('12345678-5');
    expect(e.activo).toBe(true);
  });
  it('rechaza RUT con DV incorrecto', () => {
    expect(() => esquemaEmpresa.parse({ ...empresaOk, rut_emisor: '12.345.678-9' })).toThrow(/RUT/);
  });
});

describe('esquemaCliente', () => {
  it('permite giro y dirección vacíos', () => {
    const c = esquemaCliente.parse({
      cliente_id: 'CL1',
      razon_social: 'Cliente Ltda',
      nombre_carpeta: 'NCA',
      rut_cliente: '11.111.111-1',
      email_facturacion: 'pagos@cliente.cl',
      giro: '',
      direccion: '',
      comuna: '',
      ciudad: '',
      activo: 'TRUE',
    });
    expect(c.giro).toBe('');
    expect(c.rut_cliente).toBe('11111111-1');
  });
});

describe('esquemaCobro', () => {
  it('convierte números y fecha_fin vacía a null', () => {
    const c = esquemaCobro.parse(cobroOk);
    expect(c.monto_neto).toBe(33.5);
    expect(c.dia_emision).toBe(5);
    expect(c.fecha_fin).toBeNull();
  });
  it('rechaza CONTADO con dias_vencimiento distinto de 0', () => {
    expect(() => esquemaCobro.parse({ ...cobroOk, dias_vencimiento: '30' })).toThrow(/CONTADO/);
  });
  it('rechaza moneda desconocida y dia_emision fuera de rango', () => {
    expect(() => esquemaCobro.parse({ ...cobroOk, moneda: 'USD' })).toThrow();
    expect(() => esquemaCobro.parse({ ...cobroOk, dia_emision: '29' })).toThrow();
  });
});
