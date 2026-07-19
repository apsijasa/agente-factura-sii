// tests/services/logger.test.ts
import { describe, expect, it } from 'vitest';
import { redactarTexto, redactarValor } from '../../src/services/logger.js';

describe('redactarTexto', () => {
  it('redacta RUT de 8 dígitos con puntos', () => {
    const salida = redactarTexto('cliente 12.345.678-5 activo');
    expect(salida).not.toContain('12.345.678-5');
    expect(salida).toContain('***-*');
  });

  it('redacta RUT de 8 dígitos sin puntos', () => {
    const salida = redactarTexto('cliente 12345678-5 activo');
    expect(salida).not.toContain('12345678-5');
    expect(salida).toContain('***-*');
  });

  it('redacta RUT de 6 dígitos con puntos', () => {
    const salida = redactarTexto('empresa 123.456-7 registrada');
    expect(salida).not.toContain('123.456-7');
    expect(salida).toContain('***-*');
  });

  it('redacta RUT de 6 dígitos sin puntos', () => {
    const salida = redactarTexto('empresa 123456-7 registrada');
    expect(salida).not.toContain('123456-7');
    expect(salida).toContain('***-*');
  });

  it('redacta RUT de 7 dígitos y dígito verificador K', () => {
    const salida = redactarTexto('rut 1.234.567-K');
    expect(salida).not.toContain('1.234.567-K');
    expect(salida).toContain('***-*');
  });

  it('redacta correos electrónicos', () => {
    const salida = redactarTexto('avisar a pagos@cliente.cl por favor');
    expect(salida).not.toContain('pagos@cliente.cl');
    expect(salida).toContain('***@***');
  });

  it('redacta tokens Bearer y JWT', () => {
    expect(redactarTexto('auth Bearer abc.def.ghi fin')).not.toContain('abc.def.ghi');
    expect(redactarTexto('token eyJhbGci.eyJzdWIi.firma')).toContain('[TOKEN]');
  });

  it('no redacta períodos como 2026-07', () => {
    expect(redactarTexto('período 2026-07 facturado')).toBe('período 2026-07 facturado');
  });
});

describe('redactarValor', () => {
  it('redacta strings dentro de objetos y arreglos anidados', () => {
    const entrada = {
      factura: {
        rut_cliente: '12345678-5',
        destinatarios: ['pagos@cliente.cl', 'finanzas@cliente.cl'],
      },
      monto: 100000,
    };
    const salida = redactarValor(entrada) as typeof entrada;
    expect(salida.factura.rut_cliente).not.toContain('12345678-5');
    expect(salida.factura.destinatarios[0]).not.toContain('pagos@cliente.cl');
    expect(salida.factura.destinatarios[1]).not.toContain('finanzas@cliente.cl');
    expect(salida.monto).toBe(100000);
  });

  it('no muta el objeto original', () => {
    const entrada = { rut: '12345678-5' };
    redactarValor(entrada);
    expect(entrada.rut).toBe('12345678-5');
  });

  it('no se cuelga con referencias circulares', () => {
    const entrada: Record<string, unknown> = { rut: '12345678-5' };
    entrada.self = entrada;
    const salida = redactarValor(entrada) as Record<string, unknown>;
    expect(salida.rut).not.toContain('12345678-5');
    expect(salida.self).toBe('[CIRCULAR]');
  });

  it('deja pasar valores primitivos no string sin cambios', () => {
    expect(redactarValor(42)).toBe(42);
    expect(redactarValor(null)).toBeNull();
    expect(redactarValor(true)).toBe(true);
  });
});
