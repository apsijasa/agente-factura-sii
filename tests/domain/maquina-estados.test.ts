// tests/domain/maquina-estados.test.ts
import { describe, expect, it } from 'vitest';
import { assertTransicion, puedeTransicionar } from '../../src/domain/maquina-estados.js';

describe('puedeTransicionar', () => {
  it('permite las transiciones principales del diseño', () => {
    expect(puedeTransicionar('BORRADOR', 'PENDIENTE_APROBACION')).toBe(true);
    expect(puedeTransicionar('PENDIENTE_APROBACION', 'APROBADA')).toBe(true);
    expect(puedeTransicionar('PENDIENTE_APROBACION', 'CANCELADA')).toBe(true);
    expect(puedeTransicionar('APROBADA', 'EMITIENDO')).toBe(true);
    expect(puedeTransicionar('EMITIENDO', 'EMITIDA')).toBe(true);
    expect(puedeTransicionar('EMITIENDO', 'REQUIERE_REVISION')).toBe(true);
    expect(puedeTransicionar('EMITIDA', 'DESCARGADA')).toBe(true);
    expect(puedeTransicionar('DESCARGADA', 'ENVIADA')).toBe(true);
    expect(puedeTransicionar('ERROR_REINTENTABLE', 'ENVIADA')).toBe(true);
  });

  it('nunca permite volver desde EMITIDA hacia un estado que pueda emitir de nuevo', () => {
    for (const destino of ['BORRADOR', 'PENDIENTE_APROBACION', 'APROBADA', 'EMITIENDO'] as const) {
      expect(puedeTransicionar('EMITIDA', destino)).toBe(false);
      expect(puedeTransicionar('DESCARGADA', destino)).toBe(false);
      expect(puedeTransicionar('ENVIADA', destino)).toBe(false);
      expect(puedeTransicionar('ERROR_REINTENTABLE', destino)).toBe(false);
    }
  });

  it('los estados terminales no tienen salidas', () => {
    expect(puedeTransicionar('ENVIADA', 'ERROR_REINTENTABLE')).toBe(false);
    expect(puedeTransicionar('CANCELADA', 'BORRADOR')).toBe(false);
    expect(puedeTransicionar('REQUIERE_REVISION', 'EMITIENDO')).toBe(false);
  });
});

describe('assertTransicion', () => {
  it('lanza con mensaje claro ante transición prohibida', () => {
    expect(() => assertTransicion('EMITIDA', 'EMITIENDO')).toThrow(/EMITIDA.*EMITIENDO/);
    expect(() => assertTransicion('BORRADOR', 'PENDIENTE_APROBACION')).not.toThrow();
  });
});
