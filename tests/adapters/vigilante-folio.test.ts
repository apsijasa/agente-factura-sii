// tests/adapters/vigilante-folio.test.ts
import { describe, expect, it } from 'vitest';
import { VigilanteFolio } from '../../src/adapters/sii/vigilante-folio.js';

describe('VigilanteFolio', () => {
  it('ignora todo mientras no está armado', () => {
    const v = new VigilanteFolio();
    expect(v.observar({ texto: 'FACTURA ELECTRÓNICA N° 44' })).toBeNull();
    expect(v.capturado).toBeNull();
  });

  it('captura el folio de una confirmación fugaz apenas se ve', () => {
    const v = new VigilanteFolio();
    v.armar();
    expect(v.observar({ texto: 'FACTURA ELECTRÓNICA N° 46' })).toBe('46');
    expect(v.capturado).toBe('46');
  });

  it('captura el folio desde la URL del DTE', () => {
    const v = new VigilanteFolio();
    v.armar();
    expect(v.observar({ url: 'https://www1.sii.cl/mipeShowDte.cgi?RUT=1&FOLIO=48' })).toBe('48');
  });

  it('el primero visto gana: una navegación posterior no lo cambia', () => {
    const v = new VigilanteFolio();
    v.armar();
    v.observar({ texto: 'FACTURA ELECTRÓNICA N° 50' });
    v.observar({ texto: 'FACTURA ELECTRÓNICA N° 51' });
    expect(v.capturado).toBe('50');
  });

  // La garantía que faltaba el 2026-08-25: en un lote todas las facturas
  // comparten navegador y la ventana de la anterior puede seguir abierta.
  it('no adjudica a una factura el folio de la anterior', () => {
    const v = new VigilanteFolio();
    v.armar();
    v.observar({ texto: 'FACTURA ELECTRÓNICA N° 44' });
    expect(v.capturado).toBe('44');
    v.desarmar();

    // Entre facturas queda visible la confirmación anterior: no debe contar.
    expect(v.observar({ texto: 'FACTURA ELECTRÓNICA N° 44' })).toBeNull();

    v.armar();
    expect(v.capturado).toBeNull();
    // Y si la ventana vieja sigue ahí, gana igual la primera que se vea:
    // por eso la limpieza de ventanas ocurre antes de cada emisión.
    expect(v.observar({ texto: 'FACTURA ELECTRÓNICA N° 45' })).toBe('45');
  });

  it('sigue en null si la confirmación nunca aparece', () => {
    const v = new VigilanteFolio();
    v.armar();
    v.observar({ url: 'https://www1.sii.cl/mipeMenu.cgi', texto: 'SISTEMA DE FACTURACIÓN GRATUITO' });
    expect(v.capturado).toBeNull();
  });
});
