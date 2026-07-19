import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      thresholds: { lines: 80 },
      // Solo el código fuente cuenta para la cobertura (no tests ni configs).
      include: ['src/**/*.ts'],
      // Excluidos de la cobertura: adaptadores/wiring que solo se pueden
      // ejercitar contra servicios externos reales (Playwright visible,
      // device-code MSAL interactivo, el llavero de macOS) o que son pura
      // composición de dependencias sin lógica propia. Se prueban con
      // integración manual (Task 20, docs/setup.md §7), no con vitest.
      exclude: [
        'src/adapters/sii/sii-adapter.ts', // Playwright visible contra el SII real; sin mocks de UI headful.
        'src/adapters/graph/graph-client.ts', // Flujo device-code MSAL interactivo; requiere sesión real de usuario.
        'src/config/keychain.ts', // Invoca el binario `security` del llavero de macOS.
        'src/cli/index.ts', // Wiring de commander + composición de dependencias; sin lógica propia.
      ],
    },
  },
});
