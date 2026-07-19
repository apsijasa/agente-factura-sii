// tests/adapters/sii-adapter.test.ts
// Solo lógica pura: el flujo Playwright se valida manualmente con `preview-sii`.
import { describe, expect, it } from 'vitest';
import { EmisionConfirmadaSinPdfError } from '../../src/adapters/sii/sii-adapter.js';

describe('EmisionConfirmadaSinPdfError', () => {
  it('preserva el folio y describe el fallo de descarga del PDF', () => {
    const error = new EmisionConfirmadaSinPdfError('12345', 'timeout esperando la descarga');
    expect(error).toBeInstanceOf(Error);
    expect(error.folio).toBe('12345');
    expect(error.message).toContain('12345');
    expect(error.message).toContain('PDF');
    expect(error.message).toContain('timeout esperando la descarga');
  });
});
