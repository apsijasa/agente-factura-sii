// tests/domain/motor.test.ts
import { describe, expect, it } from 'vitest';
import { construirPayload } from '../../src/domain/motor.js';
import type { GrupoFacturable } from '../../src/domain/agrupacion.js';
import type { Cliente, CobroRecurrente, Empresa } from '../../src/domain/tipos.js';

const empresa: Empresa = {
  empresa_id: 'E1', rut_emisor: '12345678-5', razon_social: 'Emisora SpA',
  email_remitente: 'facturas@empresa.cl', email_copia: 'copia@empresa.cl', activo: true,
};

const cliente: Cliente = {
  cliente_id: 'CL1', razon_social: 'Cliente Ltda', nombre_carpeta: 'NCA',
  rut_cliente: '11111111-1', email_facturacion: 'pagos@cliente.cl; finanzas@cliente.cl',
  giro: 'Servicios', direccion: 'Calle 1', comuna: 'Providencia', ciudad: 'Santiago', activo: true,
};

function cobro(sobrescribe: Partial<CobroRecurrente>): CobroRecurrente {
  return {
    cobro_id: 'C1', empresa_id: 'E1', cliente_id: 'CL1', descripcion_servicio: 'Asesoría',
    moneda: 'UF', monto_neto: 33.5, cantidad: 1, frecuencia: 'MENSUAL', dia_emision: 5,
    forma_pago: 'CONTADO', dias_vencimiento: 0, fecha_inicio: '2026-01-01', fecha_fin: null,
    activo: true, ...sobrescribe,
  };
}

const grupo: GrupoFacturable = {
  clave: 'RECURRENT:E1:CL1:2026-07', empresaId: 'E1', clienteId: 'CL1',
  periodo: '2026-07', fechaProgramada: '2026-07-05',
  cobros: [cobro({}), cobro({ cobro_id: 'C2', moneda: 'CLP', monto_neto: 100000 })],
};

const clasificacion = { tipoVenta: 'Del Giro', tipoCompra: 'Del Giro' };

describe('construirPayload', () => {
  it('arma el payload completo con UF, líneas, totales y destinatarios', () => {
    const p = construirPayload(grupo, empresa, cliente, clasificacion, 39418.53);
    expect(p.factura_id).toBe('RECURRENT:E1:CL1:2026-07');
    expect(p.fecha_emision).toBe('2026-07-05');
    expect(p.fecha_vencimiento).toBe('2026-07-05');
    expect(p.valor_uf).toBe(39418.53);
    expect(p.lineas.map((l) => l.total_linea_clp)).toEqual([1320521, 100000]);
    expect(p.neto_clp).toBe(1420521);
    expect(p.iva_clp).toBe(269899); // 1420521 * 0.19 = 269898.99 -> 269899
    expect(p.total_clp).toBe(1690420);
    expect(p.destinatarios).toEqual(['pagos@cliente.cl', 'finanzas@cliente.cl']);
    expect(p.copia).toEqual(['copia@empresa.cl']);
    expect(p.tipo_venta).toBe('Del Giro');
  });

  it('exige valor UF cuando hay líneas UF', () => {
    expect(() => construirPayload(grupo, empresa, cliente, clasificacion, null)).toThrow(/UF/);
  });

  it('acepta valorUf null cuando todas las líneas son CLP', () => {
    const soloClp: GrupoFacturable = { ...grupo, cobros: [cobro({ moneda: 'CLP', monto_neto: 100000 })] };
    const p = construirPayload(soloClp, empresa, cliente, clasificacion, null);
    expect(p.valor_uf).toBeNull();
    expect(p.neto_clp).toBe(100000);
  });

  it('rechaza formas de pago mezcladas dentro del grupo', () => {
    const mezclado: GrupoFacturable = {
      ...grupo,
      cobros: [cobro({}), cobro({ cobro_id: 'C3', forma_pago: 'CREDITO', dias_vencimiento: 30 })],
    };
    expect(() => construirPayload(mezclado, empresa, cliente, clasificacion, 39418.53)).toThrow(/forma_pago/);
  });

  it('usa vencimiento a crédito cuando corresponde', () => {
    const credito: GrupoFacturable = {
      ...grupo,
      cobros: [cobro({ forma_pago: 'CREDITO', dias_vencimiento: 30, moneda: 'CLP', monto_neto: 100000 })],
    };
    const p = construirPayload(credito, empresa, cliente, clasificacion, null);
    expect(p.fecha_vencimiento).toBe('2026-08-04');
  });
});
