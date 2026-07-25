// tests/services/token-aprobacion.test.ts
import { describe, expect, it } from 'vitest';
import { crearToken, verificarToken } from '../../src/services/token-aprobacion.js';

const SECRETO = 'secreto-de-prueba';
const datos = {
  facturaId: 'RECURRENT:E1:CL1:2026-07',
  payloadHash: 'abc123',
  expiraEn: '2026-07-26T00:00:00.000Z',
};

describe('token de aprobación', () => {
  it('crea y verifica un token válido (ida y vuelta)', () => {
    const token = crearToken(datos, SECRETO);
    const verificado = verificarToken(token, SECRETO, new Date('2026-07-25T12:00:00Z'));
    expect(verificado).toEqual(datos);
  });

  it('rechaza un token expirado', () => {
    const token = crearToken(datos, SECRETO);
    expect(() => verificarToken(token, SECRETO, new Date('2026-07-27T00:00:00Z'))).toThrow(/expir/i);
  });

  it('rechaza un token alterado (cambio de factura)', () => {
    const token = crearToken(datos, SECRETO);
    const [cuerpo, firma] = token.split('.');
    const alterado = Buffer.from(
      JSON.stringify({ ...datos, facturaId: 'OTRA' }),
    ).toString('base64url');
    expect(() => verificarToken(`${alterado}.${firma}`, SECRETO, new Date('2026-07-25T12:00:00Z'))).toThrow(
      /firma|inválido/i,
    );
    expect(cuerpo).not.toBe(alterado);
  });

  it('rechaza un token firmado con otro secreto', () => {
    const token = crearToken(datos, 'otro-secreto');
    expect(() => verificarToken(token, SECRETO, new Date('2026-07-25T12:00:00Z'))).toThrow(/firma|inválido/i);
  });

  it('rechaza formatos malformados sin lanzar errores crípticos', () => {
    expect(() => verificarToken('basura', SECRETO, new Date())).toThrow(/inválido/i);
    expect(() => verificarToken('a.b.c', SECRETO, new Date())).toThrow(/inválido/i);
  });
});
