// tests/domain/agrupacion.test.ts
import { describe, expect, it } from 'vitest';
import { agruparCobros, claveFactura } from '../../src/domain/agrupacion.js';
import type { CobroRecurrente } from '../../src/domain/tipos.js';

function cobro(sobrescribe: Partial<CobroRecurrente>): CobroRecurrente {
  return {
    cobro_id: 'C1',
    empresa_id: 'E1',
    cliente_id: 'CL1',
    descripcion_servicio: 'Servicio',
    moneda: 'CLP',
    monto_neto: 100000,
    cantidad: 1,
    frecuencia: 'MENSUAL',
    dia_emision: 5,
    forma_pago: 'CONTADO',
    dias_vencimiento: 0,
    fecha_inicio: '2026-01-01',
    fecha_fin: null,
    activo: true,
    ...sobrescribe,
  };
}

describe('claveFactura', () => {
  it('construye la clave determinista RECURRENT', () => {
    expect(claveFactura('E1', 'CL1', '2026-07')).toBe('RECURRENT:E1:CL1:2026-07');
  });
});

describe('agruparCobros', () => {
  it('agrupa cobros del mismo cliente cuya fecha programada coincide con la fecha', () => {
    const { grupos, bloqueados, atrasados } = agruparCobros(
      [cobro({ cobro_id: 'C1' }), cobro({ cobro_id: 'C2', monto_neto: 50000 })],
      '2026-07-05',
      '2026-07-05',
    );
    expect(bloqueados).toHaveLength(0);
    expect(atrasados).toHaveLength(0);
    expect(grupos).toHaveLength(1);
    expect(grupos[0]?.clave).toBe('RECURRENT:E1:CL1:2026-07');
    expect(grupos[0]?.cobros.map((c) => c.cobro_id)).toEqual(['C1', 'C2']);
  });

  it('bloquea el grupo si los días de emisión difieren', () => {
    const { grupos, bloqueados } = agruparCobros(
      [cobro({ cobro_id: 'C1', dia_emision: 5 }), cobro({ cobro_id: 'C2', dia_emision: 10 })],
      '2026-07-05',
      '2026-07-05',
    );
    expect(grupos).toHaveLength(0);
    expect(bloqueados).toHaveLength(1);
    expect(bloqueados[0]?.motivo).toMatch(/dia_emision/);
  });

  it('excluye inactivos y no vigentes', () => {
    const { grupos } = agruparCobros(
      [
        cobro({ cobro_id: 'C1', activo: false }),
        cobro({ cobro_id: 'C2', fecha_inicio: '2026-08-01' }),
      ],
      '2026-07-05',
      '2026-07-05',
    );
    expect(grupos).toHaveLength(0);
  });

  it('reporta como atrasado un grupo cuya fecha programada ya pasó', () => {
    const { grupos, atrasados } = agruparCobros(
      [cobro({ cobro_id: 'C1', dia_emision: 2 })],
      '2026-07-05',
      '2026-07-05',
    );
    expect(grupos).toHaveLength(0);
    expect(atrasados).toHaveLength(1);
    expect(atrasados[0]?.fechaProgramada).toBe('2026-07-02');
  });

  it('separa grupos por cliente distinto', () => {
    const { grupos } = agruparCobros(
      [cobro({ cobro_id: 'C1' }), cobro({ cobro_id: 'C2', cliente_id: 'CL2' })],
      '2026-07-05',
      '2026-07-05',
    );
    expect(grupos.map((g) => g.clave).sort()).toEqual([
      'RECURRENT:E1:CL1:2026-07',
      'RECURRENT:E1:CL2:2026-07',
    ]);
  });
});
