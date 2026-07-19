# Agente de Facturación SII — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CLI local en Node.js/TypeScript que lee cobros recurrentes desde Excel/OneDrive, prepara facturas en el SII con aprobación humana, descarga el PDF, lo archiva, lo envía por Microsoft Graph y audita todo en SQLite + `tblFacturas`.

**Architecture:** Núcleo de dominio puro (validación, cálculo, agrupación, hash, máquina de estados) sin I/O, rodeado de adaptadores (Graph/Excel, UF, SII/Playwright, correo, keychain) tras interfaces reemplazables. SQLite es la fuente operativa; Excel es espejo de trazabilidad. Modo predeterminado: `simulacion`.

**Tech Stack:** Node 20+, TypeScript 5, pnpm, commander, zod, decimal.js, better-sqlite3, cheerio, @azure/msal-node, Playwright, pino, proper-lockfile, vitest, tsx.

**Spec:** `docs/superpowers/specs/2026-07-18-agente-facturacion-sii-design.md`

---

## Estructura de archivos

```text
src/
  cli/index.ts               # commander: prepare | preview-sii | emit | retry-email | setup
  cli/lock.ts                # bloqueo de proceso único
  config/config.ts           # carga y valida .data/config.json (zod)
  config/keychain.ts         # lectura de secretos vía `security` (macOS)
  config/preflight.ts        # verificaciones previas a cada comando
  domain/tipos.ts            # interfaces Empresa/Cliente/Cobro/Payload/Estado
  domain/rut.ts              # módulo 11
  domain/dinero.ts           # decimal ROUND_HALF_UP, líneas CLP/UF, totales
  domain/fechas.ts           # período, fecha programada, vigencia, atrasos
  domain/validacion.ts       # esquemas zod de las 4 tablas
  domain/agrupacion.ts       # agrupación empresa+cliente+período
  domain/hash.ts             # JSON canónico + SHA-256
  domain/maquina-estados.ts  # transiciones permitidas
  adapters/graph/reintentos.ts    # withRetry backoff+jitter
  adapters/graph/graph-client.ts  # MSAL device code + fetch autenticado
  adapters/excel/excel-adapter.ts # lectura 4 tablas, escritura tblFacturas
  adapters/uf/uf-provider.ts      # parse tabla oficial SII
  adapters/sii/parse.ts           # montos chilenos, comparación de totales
  adapters/sii/selectores.ts      # localizadores centralizados
  adapters/sii/sii-adapter.ts     # Playwright visible, interfaz ISiiAdapter
  services/aprobacion.ts     # APROBAR <id>, hash, expiración
  services/storage.ts        # rutas confinadas, escritura atómica, verificación PDF
  services/correo.ts         # sendMail Graph, alias, adjunto
  services/logger.ts         # pino + redacción RUT/correos/secretos
  store/audit-store.ts       # SQLite: invoice_runs, invoice_lines, state_events, approvals, email_attempts
  store/facturas-repository.ts    # espejo tblFacturas + reconciliación
tests/                       # espejo de src/ (tests/domain/rut.test.ts, …)
tests/fixtures/              # HTML UF, tablas Excel, preview SII sanitizados
```

Convención: código y nombres en español, sin secretos en ningún archivo versionado. Cada task termina en commit.

---

### Task 0: Scaffold del proyecto

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `vitest.config.ts`, `.gitignore`, `.env.example`, `src/cli/index.ts` (stub)

- [ ] **Step 1: Crear package.json**

```json
{
  "name": "agente-factura-sii",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "agent": "tsx src/cli/index.ts",
    "lint": "eslint src tests",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "build": "tsc -p tsconfig.build.json"
  },
  "dependencies": {
    "@azure/msal-node": "^2.16.0",
    "better-sqlite3": "^11.3.0",
    "cheerio": "^1.0.0",
    "commander": "^12.1.0",
    "decimal.js": "^10.4.3",
    "pino": "^9.4.0",
    "playwright": "^1.47.0",
    "proper-lockfile": "^4.1.2",
    "tsx": "^4.19.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.5.0",
    "@types/proper-lockfile": "^4.1.4",
    "eslint": "^9.10.0",
    "typescript": "^5.6.2",
    "typescript-eslint": "^8.5.0",
    "vitest": "^2.1.1"
  }
}
```

- [ ] **Step 2: Crear tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

`tsconfig.build.json`:

```json
{ "extends": "./tsconfig.json", "include": ["src"] }
```

- [ ] **Step 3: Crear vitest.config.ts y eslint.config.js**

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], coverage: { provider: 'v8', thresholds: { lines: 80 } } },
});
```

```js
// eslint.config.js
import tseslint from 'typescript-eslint';
export default tseslint.config(...tseslint.configs.recommended, {
  rules: { '@typescript-eslint/no-explicit-any': 'error' },
});
```

- [ ] **Step 4: Crear .gitignore y .env.example**

`.gitignore`:

```text
node_modules/
dist/
.env
.data/
*.sqlite*
playwright/.auth/
test-results/
.DS_Store
```

`.env.example` (solo documentación, sin valores):

```text
# La configuración vive en .data/config.json (no versionado), creada por `pnpm agent -- setup`.
# Secretos: llavero de macOS. Este archivo existe solo como recordatorio; no poner credenciales aquí.
```

- [ ] **Step 5: Stub del CLI**

```ts
// src/cli/index.ts
import { Command } from 'commander';

const programa = new Command('agente-factura-sii');
programa.description('Agente local de facturación SII (modo predeterminado: simulacion)');
programa.parse(process.argv);
```

- [ ] **Step 6: Instalar y verificar**

Run: `pnpm install && pnpm typecheck && pnpm agent -- --help`
Expected: sin errores; ayuda del CLI impresa.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json vitest.config.ts eslint.config.js .gitignore .env.example src/cli/index.ts
git commit -m "chore: scaffold TypeScript CLI con vitest y eslint"
```

---

### Task 1: Validación de RUT (módulo 11)

**Files:**
- Create: `src/domain/rut.ts`
- Test: `tests/domain/rut.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// tests/domain/rut.test.ts
import { describe, expect, it } from 'vitest';
import { calcularDv, esRutValido, normalizarRut, ocultarRut } from '../../src/domain/rut.js';

describe('normalizarRut', () => {
  it('limpia puntos y espacios y fuerza mayúscula', () => {
    expect(normalizarRut('12.345.678-5')).toBe('12345678-5');
    expect(normalizarRut(' 11111111-1 ')).toBe('11111111-1');
    expect(normalizarRut('9.999.999-k')).toBe('9999999-K');
  });
  it('devuelve null ante formato inválido', () => {
    expect(normalizarRut('')).toBeNull();
    expect(normalizarRut('abc')).toBeNull();
    expect(normalizarRut('12345678')).toBeNull();
  });
});

describe('calcularDv', () => {
  it('calcula dígito verificador módulo 11', () => {
    expect(calcularDv('12345678')).toBe('5');
    expect(calcularDv('11111111')).toBe('1');
  });
});

describe('esRutValido', () => {
  it('acepta RUT con DV correcto', () => {
    expect(esRutValido('12.345.678-5')).toBe(true);
  });
  it('rechaza DV incorrecto', () => {
    expect(esRutValido('12.345.678-9')).toBe(false);
  });
});

describe('ocultarRut', () => {
  it('enmascara el cuerpo dejando primeros 2 dígitos y DV', () => {
    expect(ocultarRut('12345678-5')).toBe('12******-5');
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `pnpm vitest run tests/domain/rut.test.ts`
Expected: FAIL — módulo `src/domain/rut.js` no existe.

- [ ] **Step 3: Implementación mínima**

```ts
// src/domain/rut.ts
export function normalizarRut(entrada: string): string | null {
  const limpio = entrada.replace(/[.\s]/g, '').toUpperCase();
  const m = /^(\d{1,8})-([\dK])$/.exec(limpio);
  return m ? `${m[1]}-${m[2]}` : null;
}

export function calcularDv(cuerpo: string): string {
  let suma = 0;
  let factor = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const resto = 11 - (suma % 11);
  if (resto === 11) return '0';
  if (resto === 10) return 'K';
  return String(resto);
}

export function esRutValido(entrada: string): boolean {
  const norm = normalizarRut(entrada);
  if (!norm) return false;
  const [cuerpo, dv] = norm.split('-') as [string, string];
  return calcularDv(cuerpo) === dv;
}

export function ocultarRut(rutNormalizado: string): string {
  const [cuerpo, dv] = rutNormalizado.split('-') as [string, string];
  return `${cuerpo.slice(0, 2)}${'*'.repeat(Math.max(0, cuerpo.length - 2))}-${dv}`;
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `pnpm vitest run tests/domain/rut.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/rut.ts tests/domain/rut.test.ts
git commit -m "feat: validación y normalización de RUT módulo 11"
```

---

### Task 2: Aritmética decimal y totales esperados

**Files:**
- Create: `src/domain/dinero.ts`
- Test: `tests/domain/dinero.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// tests/domain/dinero.test.ts
import { describe, expect, it } from 'vitest';
import { lineaClp, lineaUf, redondearHalfUp, totalesEsperados } from '../../src/domain/dinero.js';

describe('redondearHalfUp', () => {
  it('redondea 0.5 hacia arriba', () => {
    expect(redondearHalfUp('2.5')).toBe(3);
    expect(redondearHalfUp('2.4')).toBe(2);
    expect(redondearHalfUp('1320520.755')).toBe(1320521);
  });
});

describe('lineaClp', () => {
  it('multiplica monto entero por cantidad', () => {
    expect(lineaClp(95000, 2)).toEqual({ precioUnitarioClp: 95000, totalLineaClp: 190000 });
  });
  it('rechaza monto CLP no entero', () => {
    expect(() => lineaClp(95000.5, 1)).toThrow(/entero/);
  });
  it('rechaza cantidad no positiva', () => {
    expect(() => lineaClp(95000, 0)).toThrow(/cantidad/);
  });
});

describe('lineaUf', () => {
  it('convierte UF a CLP redondeando el precio unitario primero', () => {
    // 33.5 UF * 39418.53 = 1.320.520,755 -> 1.320.521
    expect(lineaUf(33.5, 1, 39418.53)).toEqual({ precioUnitarioClp: 1320521, totalLineaClp: 1320521 });
  });
  it('multiplica el unitario ya redondeado por la cantidad', () => {
    // 2.5 UF * 39418.53 = 98.546,325 -> 98.546; * 3 = 295.638
    expect(lineaUf(2.5, 3, 39418.53)).toEqual({ precioUnitarioClp: 98546, totalLineaClp: 295638 });
  });
});

describe('totalesEsperados', () => {
  it('suma líneas y calcula IVA 19% con redondeo half-up', () => {
    // neto 1.320.521 -> IVA 250.898,99 -> 250.899
    expect(totalesEsperados([1320521])).toEqual({ netoClp: 1320521, ivaClp: 250899, totalClp: 1571420 });
  });
  it('rechaza lista vacía', () => {
    expect(() => totalesEsperados([])).toThrow(/líneas/);
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `pnpm vitest run tests/domain/dinero.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 3: Implementación mínima**

```ts
// src/domain/dinero.ts
import { Decimal } from 'decimal.js';

const D = Decimal.clone({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export interface LineaCalculada {
  precioUnitarioClp: number;
  totalLineaClp: number;
}

export function redondearHalfUp(valor: Decimal.Value): number {
  return new D(valor).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

export function lineaClp(montoNeto: number, cantidad: number): LineaCalculada {
  if (!Number.isInteger(montoNeto) || montoNeto <= 0) {
    throw new Error(`monto_neto CLP debe ser un entero positivo, recibido: ${montoNeto}`);
  }
  validarCantidad(cantidad);
  return { precioUnitarioClp: montoNeto, totalLineaClp: montoNeto * cantidad };
}

export function lineaUf(montoNetoUf: number, cantidad: number, valorUf: number): LineaCalculada {
  if (montoNetoUf <= 0) throw new Error(`monto_neto UF debe ser positivo, recibido: ${montoNetoUf}`);
  if (valorUf <= 0) throw new Error(`valor_uf debe ser positivo, recibido: ${valorUf}`);
  validarCantidad(cantidad);
  const precioUnitarioClp = redondearHalfUp(new D(montoNetoUf).mul(valorUf));
  return { precioUnitarioClp, totalLineaClp: precioUnitarioClp * cantidad };
}

export function totalesEsperados(totalesLinea: number[]): { netoClp: number; ivaClp: number; totalClp: number } {
  if (totalesLinea.length === 0) throw new Error('No hay líneas para totalizar');
  const netoClp = totalesLinea.reduce((a, b) => a + b, 0);
  const ivaClp = redondearHalfUp(new D(netoClp).mul('0.19'));
  return { netoClp, ivaClp, totalClp: netoClp + ivaClp };
}

function validarCantidad(cantidad: number): void {
  if (!(cantidad > 0)) throw new Error(`cantidad debe ser positiva, recibido: ${cantidad}`);
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `pnpm vitest run tests/domain/dinero.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/dinero.ts tests/domain/dinero.test.ts
git commit -m "feat: aritmética decimal ROUND_HALF_UP para líneas y totales"
```

---

### Task 3: Fechas, períodos y vigencia

**Files:**
- Create: `src/domain/fechas.ts`
- Test: `tests/domain/fechas.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// tests/domain/fechas.test.ts
import { describe, expect, it } from 'vitest';
import {
  esVigente,
  estaAtrasada,
  fechaProgramada,
  fechaVencimiento,
  periodoDe,
} from '../../src/domain/fechas.js';

describe('periodoDe', () => {
  it('extrae AAAA-MM de una fecha ISO', () => {
    expect(periodoDe('2026-07-18')).toBe('2026-07');
  });
});

describe('fechaProgramada', () => {
  it('combina período con día de emisión con cero a la izquierda', () => {
    expect(fechaProgramada('2026-07', 5)).toBe('2026-07-05');
    expect(fechaProgramada('2026-07', 28)).toBe('2026-07-28');
  });
  it('rechaza día fuera de 1..28', () => {
    expect(() => fechaProgramada('2026-07', 29)).toThrow(/dia_emision/);
    expect(() => fechaProgramada('2026-07', 0)).toThrow(/dia_emision/);
  });
});

describe('esVigente', () => {
  const cobro = { fecha_inicio: '2026-01-01', fecha_fin: null as string | null };
  it('vigente cuando fecha >= inicio y sin fecha_fin', () => {
    expect(esVigente(cobro, '2026-07-18')).toBe(true);
    expect(esVigente(cobro, '2025-12-31')).toBe(false);
  });
  it('respeta fecha_fin inclusiva', () => {
    const acotado = { fecha_inicio: '2026-01-01', fecha_fin: '2026-06-30' };
    expect(esVigente(acotado, '2026-06-30')).toBe(true);
    expect(esVigente(acotado, '2026-07-01')).toBe(false);
  });
});

describe('estaAtrasada', () => {
  it('detecta fecha programada anterior a hoy', () => {
    expect(estaAtrasada('2026-07-05', '2026-07-18')).toBe(true);
    expect(estaAtrasada('2026-07-18', '2026-07-18')).toBe(false);
  });
});

describe('fechaVencimiento', () => {
  it('CONTADO vence el mismo día', () => {
    expect(fechaVencimiento('2026-07-18', 'CONTADO', 0)).toBe('2026-07-18');
  });
  it('CREDITO suma dias_vencimiento', () => {
    expect(fechaVencimiento('2026-07-18', 'CREDITO', 30)).toBe('2026-08-17');
  });
  it('rechaza CONTADO con días distintos de cero', () => {
    expect(() => fechaVencimiento('2026-07-18', 'CONTADO', 30)).toThrow(/CONTADO/);
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `pnpm vitest run tests/domain/fechas.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 3: Implementación mínima**

```ts
// src/domain/fechas.ts
export function periodoDe(fechaIso: string): string {
  return fechaIso.slice(0, 7);
}

export function fechaProgramada(periodo: string, diaEmision: number): string {
  if (!Number.isInteger(diaEmision) || diaEmision < 1 || diaEmision > 28) {
    throw new Error(`dia_emision debe estar entre 1 y 28, recibido: ${diaEmision}`);
  }
  return `${periodo}-${String(diaEmision).padStart(2, '0')}`;
}

export function esVigente(
  cobro: { fecha_inicio: string; fecha_fin: string | null },
  fechaIso: string,
): boolean {
  if (fechaIso < cobro.fecha_inicio) return false;
  if (cobro.fecha_fin && fechaIso > cobro.fecha_fin) return false;
  return true;
}

export function estaAtrasada(fechaProgramadaIso: string, hoyIso: string): boolean {
  return fechaProgramadaIso < hoyIso;
}

export function fechaVencimiento(
  fechaEmisionIso: string,
  formaPago: 'CONTADO' | 'CREDITO',
  diasVencimiento: number,
): string {
  if (formaPago === 'CONTADO') {
    if (diasVencimiento !== 0) throw new Error('CONTADO exige dias_vencimiento = 0');
    return fechaEmisionIso;
  }
  const fecha = new Date(`${fechaEmisionIso}T00:00:00Z`);
  fecha.setUTCDate(fecha.getUTCDate() + diasVencimiento);
  return fecha.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `pnpm vitest run tests/domain/fechas.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/fechas.ts tests/domain/fechas.test.ts
git commit -m "feat: períodos, fechas programadas, vigencia y vencimiento"
```

---

### Task 4: Tipos de dominio y validación zod de las 4 tablas

**Files:**
- Create: `src/domain/tipos.ts`, `src/domain/validacion.ts`
- Test: `tests/domain/validacion.test.ts`

- [ ] **Step 1: Crear los tipos compartidos (sin test propio; se ejercitan en validación)**

```ts
// src/domain/tipos.ts
export type Moneda = 'CLP' | 'UF';
export type FormaPago = 'CONTADO' | 'CREDITO';

export type Estado =
  | 'BORRADOR'
  | 'PENDIENTE_APROBACION'
  | 'APROBADA'
  | 'EMITIENDO'
  | 'EMITIDA'
  | 'DESCARGADA'
  | 'ENVIADA'
  | 'ERROR_REINTENTABLE'
  | 'REQUIERE_REVISION'
  | 'CANCELADA';

export interface Empresa {
  empresa_id: string;
  rut_emisor: string;
  razon_social: string;
  email_remitente: string;
  email_copia: string;
  activo: boolean;
}

export interface Cliente {
  cliente_id: string;
  razon_social: string;
  nombre_carpeta: string;
  rut_cliente: string;
  email_facturacion: string;
  giro: string;
  direccion: string;
  comuna: string;
  ciudad: string;
  activo: boolean;
}

export interface CobroRecurrente {
  cobro_id: string;
  empresa_id: string;
  cliente_id: string;
  descripcion_servicio: string;
  moneda: Moneda;
  monto_neto: number;
  cantidad: number;
  frecuencia: 'MENSUAL';
  dia_emision: number;
  forma_pago: FormaPago;
  dias_vencimiento: number;
  fecha_inicio: string;
  fecha_fin: string | null;
  activo: boolean;
}

export interface LineaFactura {
  cobro_id: string;
  descripcion: string;
  moneda: Moneda;
  monto_neto_original: number;
  cantidad: number;
  precio_unitario_clp: number;
  total_linea_clp: number;
}

export interface InvoicePayload {
  factura_id: string; // RECURRENT:<empresa_id>:<cliente_id>:<AAAA-MM>
  empresa_id: string;
  rut_emisor: string;
  razon_social_emisor: string;
  cliente_id: string;
  rut_cliente: string;
  razon_social_cliente: string;
  nombre_carpeta: string;
  periodo: string;
  fecha_emision: string;
  fecha_vencimiento: string;
  forma_pago: FormaPago;
  tipo_venta: string;
  tipo_compra: string;
  valor_uf: number | null;
  lineas: LineaFactura[];
  neto_clp: number;
  iva_clp: number;
  total_clp: number;
  remitente: string;
  destinatarios: string[];
  copia: string[];
}
```

- [ ] **Step 2: Escribir el test que falla**

```ts
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
```

- [ ] **Step 3: Verificar que falla**

Run: `pnpm vitest run tests/domain/validacion.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 4: Implementación mínima**

```ts
// src/domain/validacion.ts
import { z } from 'zod';
import { esRutValido, normalizarRut } from './rut.js';

const VERDADEROS = new Set(['true', 'verdadero', '1', 'si', 'sí']);
const FALSOS = new Set(['false', 'falso', '0', 'no']);

export function parsearBooleano(valor: string): boolean {
  const v = valor.trim().toLowerCase();
  if (VERDADEROS.has(v)) return true;
  if (FALSOS.has(v)) return false;
  throw new Error(`Valor booleano no reconocido: "${valor}"`);
}

const RE_CORREO = /^[^\s@;]+@[^\s@;]+\.[^\s@;]+$/;

export function parsearDestinatarios(campo: string): string[] {
  const correos = campo
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (correos.length === 0) throw new Error('Se requiere al menos un correo válido');
  for (const correo of correos) {
    if (!RE_CORREO.test(correo)) throw new Error(`Correo inválido: "${correo}"`);
  }
  return correos;
}

const rutValidado = z.string().transform((v, ctx) => {
  if (!esRutValido(v)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `RUT inválido: "${v}"` });
    return z.NEVER;
  }
  return normalizarRut(v) as string;
});

const booleano = z.string().transform((v) => parsearBooleano(v));
const correo = z.string().regex(RE_CORREO, 'Correo inválido');
const fechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha debe ser AAAA-MM-DD');
const idNoVacio = z.string().trim().min(1);

export const esquemaEmpresa = z.object({
  empresa_id: idNoVacio,
  rut_emisor: rutValidado,
  razon_social: idNoVacio,
  email_remitente: correo,
  email_copia: correo,
  activo: booleano,
});

export const esquemaCliente = z.object({
  cliente_id: idNoVacio,
  razon_social: idNoVacio,
  nombre_carpeta: idNoVacio,
  rut_cliente: rutValidado,
  email_facturacion: z.string().refine((v) => {
    try { parsearDestinatarios(v); return true; } catch { return false; }
  }, 'email_facturacion debe contener correos válidos separados por ;'),
  giro: z.string(),
  direccion: z.string(),
  comuna: z.string(),
  ciudad: z.string(),
  activo: booleano,
});

export const esquemaCobro = z
  .object({
    cobro_id: idNoVacio,
    empresa_id: idNoVacio,
    cliente_id: idNoVacio,
    descripcion_servicio: idNoVacio,
    moneda: z.enum(['CLP', 'UF']),
    monto_neto: z.coerce.number().positive(),
    cantidad: z.coerce.number().positive(),
    frecuencia: z.literal('MENSUAL'),
    dia_emision: z.coerce.number().int().min(1).max(28),
    forma_pago: z.enum(['CONTADO', 'CREDITO']),
    dias_vencimiento: z.coerce.number().int().min(0),
    fecha_inicio: fechaIso,
    fecha_fin: z
      .string()
      .transform((v) => (v.trim() === '' ? null : v))
      .pipe(fechaIso.nullable()),
    activo: booleano,
  })
  .superRefine((c, ctx) => {
    if (c.forma_pago === 'CONTADO' && c.dias_vencimiento !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'CONTADO exige dias_vencimiento = 0' });
    }
    if (c.moneda === 'CLP' && !Number.isInteger(c.monto_neto)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'monto_neto CLP debe ser entero' });
    }
  });

export type EmpresaValidada = z.output<typeof esquemaEmpresa>;
export type ClienteValidado = z.output<typeof esquemaCliente>;
export type CobroValidado = z.output<typeof esquemaCobro>;
```

- [ ] **Step 5: Verificar que pasa**

Run: `pnpm vitest run tests/domain/validacion.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 6: Commit**

```bash
git add src/domain/tipos.ts src/domain/validacion.ts tests/domain/validacion.test.ts
git commit -m "feat: tipos de dominio y validación zod de tablas maestras"
```

---

### Task 5: Agrupación de cobros por empresa, cliente y período

**Files:**
- Create: `src/domain/agrupacion.ts`
- Test: `tests/domain/agrupacion.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
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
```

- [ ] **Step 2: Verificar que falla**

Run: `pnpm vitest run tests/domain/agrupacion.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 3: Implementación mínima**

```ts
// src/domain/agrupacion.ts
import { esVigente, estaAtrasada, fechaProgramada, periodoDe } from './fechas.js';
import type { CobroRecurrente } from './tipos.js';

export interface GrupoFacturable {
  clave: string;
  empresaId: string;
  clienteId: string;
  periodo: string;
  fechaProgramada: string;
  cobros: CobroRecurrente[];
}

export interface GrupoBloqueado {
  empresaId: string;
  clienteId: string;
  periodo: string;
  motivo: string;
  cobroIds: string[];
}

export interface GrupoAtrasado extends GrupoBloqueado {
  fechaProgramada: string;
}

export function claveFactura(empresaId: string, clienteId: string, periodo: string): string {
  return `RECURRENT:${empresaId}:${clienteId}:${periodo}`;
}

export function agruparCobros(
  cobros: CobroRecurrente[],
  fechaSolicitada: string,
  hoy: string,
): { grupos: GrupoFacturable[]; bloqueados: GrupoBloqueado[]; atrasados: GrupoAtrasado[] } {
  const periodo = periodoDe(fechaSolicitada);
  const elegibles = cobros.filter(
    (c) => c.activo && c.frecuencia === 'MENSUAL' && esVigente(c, fechaSolicitada),
  );

  const porGrupo = new Map<string, CobroRecurrente[]>();
  for (const c of elegibles) {
    const clave = `${c.empresa_id}|${c.cliente_id}`;
    porGrupo.set(clave, [...(porGrupo.get(clave) ?? []), c]);
  }

  const grupos: GrupoFacturable[] = [];
  const bloqueados: GrupoBloqueado[] = [];
  const atrasados: GrupoAtrasado[] = [];

  for (const [, lista] of porGrupo) {
    const ordenada = [...lista].sort((a, b) => a.cobro_id.localeCompare(b.cobro_id));
    const primero = ordenada[0] as CobroRecurrente;
    const base = {
      empresaId: primero.empresa_id,
      clienteId: primero.cliente_id,
      periodo,
      cobroIds: ordenada.map((c) => c.cobro_id),
    };

    const dias = new Set(ordenada.map((c) => c.dia_emision));
    if (dias.size > 1) {
      bloqueados.push({ ...base, motivo: `dia_emision inconsistente: ${[...dias].join(', ')}` });
      continue;
    }

    const programada = fechaProgramada(periodo, primero.dia_emision);
    if (programada === fechaSolicitada) {
      grupos.push({
        clave: claveFactura(base.empresaId, base.clienteId, periodo),
        empresaId: base.empresaId,
        clienteId: base.clienteId,
        periodo,
        fechaProgramada: programada,
        cobros: ordenada,
      });
    } else if (estaAtrasada(programada, hoy)) {
      atrasados.push({
        ...base,
        fechaProgramada: programada,
        motivo: `período ${periodo} atrasado: programada ${programada}, hoy ${hoy}`,
      });
    }
  }

  return { grupos, bloqueados, atrasados };
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `pnpm vitest run tests/domain/agrupacion.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/agrupacion.ts tests/domain/agrupacion.test.ts
git commit -m "feat: agrupación de cobros con bloqueos y detección de atrasos"
```

---

### Task 6: Hash canónico de aprobación

**Files:**
- Create: `src/domain/hash.ts`
- Test: `tests/domain/hash.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// tests/domain/hash.test.ts
import { describe, expect, it } from 'vitest';
import { hashPayload, jsonCanonico } from '../../src/domain/hash.js';
import type { InvoicePayload } from '../../src/domain/tipos.js';

const payload: InvoicePayload = {
  factura_id: 'RECURRENT:E1:CL1:2026-07',
  empresa_id: 'E1',
  rut_emisor: '12345678-5',
  razon_social_emisor: 'Emisora SpA',
  cliente_id: 'CL1',
  rut_cliente: '11111111-1',
  razon_social_cliente: 'Cliente Ltda',
  nombre_carpeta: 'NCA',
  periodo: '2026-07',
  fecha_emision: '2026-07-05',
  fecha_vencimiento: '2026-07-05',
  forma_pago: 'CONTADO',
  tipo_venta: 'Del Giro',
  tipo_compra: 'Del Giro',
  valor_uf: 39418.53,
  lineas: [
    {
      cobro_id: 'C1',
      descripcion: 'Asesoría',
      moneda: 'UF',
      monto_neto_original: 33.5,
      cantidad: 1,
      precio_unitario_clp: 1320521,
      total_linea_clp: 1320521,
    },
  ],
  neto_clp: 1320521,
  iva_clp: 250899,
  total_clp: 1571420,
  remitente: 'facturas@empresa.cl',
  destinatarios: ['pagos@cliente.cl'],
  copia: ['copia@empresa.cl'],
};

describe('jsonCanonico', () => {
  it('ordena claves alfabéticamente en todos los niveles', () => {
    expect(jsonCanonico({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it('preserva el orden de los arreglos', () => {
    expect(jsonCanonico([2, 1])).toBe('[2,1]');
  });
});

describe('hashPayload', () => {
  it('es determinista e independiente del orden de claves', () => {
    const clon = JSON.parse(jsonCanonico(payload)) as InvoicePayload;
    expect(hashPayload(payload)).toBe(hashPayload(clon));
    expect(hashPayload(payload)).toMatch(/^[a-f0-9]{64}$/);
  });
  it('cambia si cambia cualquier campo del payload', () => {
    expect(hashPayload({ ...payload, total_clp: 1571421 })).not.toBe(hashPayload(payload));
    expect(hashPayload({ ...payload, destinatarios: ['otro@x.cl'] })).not.toBe(hashPayload(payload));
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `pnpm vitest run tests/domain/hash.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 3: Implementación mínima**

```ts
// src/domain/hash.ts
import { createHash } from 'node:crypto';
import type { InvoicePayload } from './tipos.js';

export function jsonCanonico(valor: unknown): string {
  if (valor === null || typeof valor !== 'object') return JSON.stringify(valor);
  if (Array.isArray(valor)) return `[${valor.map(jsonCanonico).join(',')}]`;
  const claves = Object.keys(valor as Record<string, unknown>).sort();
  const partes = claves.map(
    (k) => `${JSON.stringify(k)}:${jsonCanonico((valor as Record<string, unknown>)[k])}`,
  );
  return `{${partes.join(',')}}`;
}

export function hashPayload(payload: InvoicePayload): string {
  return createHash('sha256').update(jsonCanonico(payload), 'utf8').digest('hex');
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `pnpm vitest run tests/domain/hash.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/hash.ts tests/domain/hash.test.ts
git commit -m "feat: hash SHA-256 canónico del payload de aprobación"
```

---

### Task 7: Máquina de estados

**Files:**
- Create: `src/domain/maquina-estados.ts`
- Test: `tests/domain/maquina-estados.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
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
```

- [ ] **Step 2: Verificar que falla**

Run: `pnpm vitest run tests/domain/maquina-estados.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 3: Implementación mínima**

```ts
// src/domain/maquina-estados.ts
import type { Estado } from './tipos.js';

export const TRANSICIONES: Record<Estado, readonly Estado[]> = {
  BORRADOR: ['PENDIENTE_APROBACION', 'REQUIERE_REVISION', 'CANCELADA'],
  PENDIENTE_APROBACION: ['APROBADA', 'CANCELADA', 'REQUIERE_REVISION'],
  APROBADA: ['EMITIENDO', 'CANCELADA', 'REQUIERE_REVISION'],
  EMITIENDO: ['EMITIDA', 'REQUIERE_REVISION'],
  EMITIDA: ['DESCARGADA', 'ERROR_REINTENTABLE'],
  DESCARGADA: ['ENVIADA', 'ERROR_REINTENTABLE'],
  ENVIADA: [],
  ERROR_REINTENTABLE: ['DESCARGADA', 'ENVIADA', 'REQUIERE_REVISION'],
  REQUIERE_REVISION: [],
  CANCELADA: [],
};

export function puedeTransicionar(desde: Estado, hacia: Estado): boolean {
  return TRANSICIONES[desde].includes(hacia);
}

export function assertTransicion(desde: Estado, hacia: Estado): void {
  if (!puedeTransicionar(desde, hacia)) {
    throw new Error(`Transición prohibida: ${desde} -> ${hacia}`);
  }
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `pnpm vitest run tests/domain/maquina-estados.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/maquina-estados.ts tests/domain/maquina-estados.test.ts
git commit -m "feat: máquina de estados de factura sin retorno tras EMITIDA"
```

---

### Task 8: AuditStore SQLite (idempotencia y trazabilidad)

**Files:**
- Create: `src/store/audit-store.ts`
- Test: `tests/store/audit-store.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// tests/store/audit-store.test.ts
import { describe, expect, it } from 'vitest';
import { AuditStore } from '../../src/store/audit-store.js';
import type { InvoicePayload } from '../../src/domain/tipos.js';

const payload = {
  factura_id: 'RECURRENT:E1:CL1:2026-07',
  empresa_id: 'E1',
  rut_emisor: '12345678-5',
  razon_social_emisor: 'Emisora SpA',
  cliente_id: 'CL1',
  rut_cliente: '11111111-1',
  razon_social_cliente: 'Cliente Ltda',
  nombre_carpeta: 'NCA',
  periodo: '2026-07',
  fecha_emision: '2026-07-05',
  fecha_vencimiento: '2026-07-05',
  forma_pago: 'CONTADO',
  tipo_venta: 'Del Giro',
  tipo_compra: 'Del Giro',
  valor_uf: null,
  lineas: [
    {
      cobro_id: 'C1',
      descripcion: 'Servicio',
      moneda: 'CLP',
      monto_neto_original: 100000,
      cantidad: 1,
      precio_unitario_clp: 100000,
      total_linea_clp: 100000,
    },
  ],
  neto_clp: 100000,
  iva_clp: 19000,
  total_clp: 119000,
  remitente: 'facturas@empresa.cl',
  destinatarios: ['pagos@cliente.cl'],
  copia: ['copia@empresa.cl'],
} satisfies InvoicePayload;

function crearStore(): AuditStore {
  return new AuditStore(':memory:');
}

describe('AuditStore', () => {
  it('crea la factura en BORRADOR con sus líneas', () => {
    const store = crearStore();
    store.crearFactura(payload, 'hash-abc');
    const f = store.obtenerFactura(payload.factura_id);
    expect(f?.estado).toBe('BORRADOR');
    expect(f?.payload_hash).toBe('hash-abc');
    expect(store.obtenerLineas(payload.factura_id)).toHaveLength(1);
  });

  it('rechaza duplicados de la misma clave (idempotencia)', () => {
    const store = crearStore();
    store.crearFactura(payload, 'hash-abc');
    expect(() => store.crearFactura(payload, 'hash-abc')).toThrow(/existe/i);
  });

  it('registra transiciones válidas y las persiste en state_events', () => {
    const store = crearStore();
    store.crearFactura(payload, 'hash-abc');
    store.registrarTransicion(payload.factura_id, 'PENDIENTE_APROBACION', 'preparación completa');
    expect(store.obtenerFactura(payload.factura_id)?.estado).toBe('PENDIENTE_APROBACION');
    const eventos = store.obtenerEventos(payload.factura_id);
    expect(eventos.map((e) => e.hacia)).toEqual(['BORRADOR', 'PENDIENTE_APROBACION']);
  });

  it('rechaza transiciones inválidas', () => {
    const store = crearStore();
    store.crearFactura(payload, 'hash-abc');
    expect(() => store.registrarTransicion(payload.factura_id, 'EMITIDA', 'salto')).toThrow(
      /Transición prohibida/,
    );
  });

  it('registra aprobaciones e intentos de correo', () => {
    const store = crearStore();
    store.crearFactura(payload, 'hash-abc');
    store.registrarAprobacion(payload.factura_id, 'andres', 'hash-abc', '2026-07-05T10:00:00Z');
    store.registrarIntentoCorreo(payload.factura_id, false, 'alias rechazado');
    expect(store.obtenerAprobacion(payload.factura_id)?.actor).toBe('andres');
    expect(store.obtenerIntentosCorreo(payload.factura_id)).toHaveLength(1);
  });

  it('guarda folio y ruta del PDF', () => {
    const store = crearStore();
    store.crearFactura(payload, 'hash-abc');
    store.guardarFolio(payload.factura_id, '12345');
    store.guardarRutaPdf(payload.factura_id, '/ruta/Factura_12345.pdf');
    const f = store.obtenerFactura(payload.factura_id);
    expect(f?.folio_sii).toBe('12345');
    expect(f?.pdf_path).toBe('/ruta/Factura_12345.pdf');
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `pnpm vitest run tests/store/audit-store.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 3: Implementación mínima**

```ts
// src/store/audit-store.ts
import Database from 'better-sqlite3';
import { assertTransicion } from '../domain/maquina-estados.js';
import type { Estado, InvoicePayload, LineaFactura } from '../domain/tipos.js';

export interface FilaFactura {
  factura_id: string;
  estado: Estado;
  payload_json: string;
  payload_hash: string;
  folio_sii: string | null;
  pdf_path: string | null;
}

export interface EventoEstado {
  factura_id: string;
  desde: Estado | null;
  hacia: Estado;
  detalle: string;
  creado_en: string;
}

export class AuditStore {
  private readonly db: Database.Database;

  constructor(ruta: string) {
    this.db = new Database(ruta);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS invoice_runs (
        factura_id TEXT PRIMARY KEY,
        estado TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        folio_sii TEXT,
        pdf_path TEXT,
        creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS invoice_lines (
        factura_id TEXT NOT NULL REFERENCES invoice_runs(factura_id),
        cobro_id TEXT NOT NULL,
        descripcion TEXT NOT NULL,
        moneda TEXT NOT NULL,
        monto_neto_original REAL NOT NULL,
        cantidad REAL NOT NULL,
        precio_unitario_clp INTEGER NOT NULL,
        total_linea_clp INTEGER NOT NULL,
        PRIMARY KEY (factura_id, cobro_id)
      );
      CREATE TABLE IF NOT EXISTS state_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        factura_id TEXT NOT NULL,
        desde TEXT,
        hacia TEXT NOT NULL,
        detalle TEXT NOT NULL,
        creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS approvals (
        factura_id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        aprobado_en TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS email_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        factura_id TEXT NOT NULL,
        exito INTEGER NOT NULL,
        detalle TEXT NOT NULL,
        creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
  }

  crearFactura(payload: InvoicePayload, payloadHash: string): void {
    const existe = this.obtenerFactura(payload.factura_id);
    if (existe) throw new Error(`La factura ${payload.factura_id} ya existe (idempotencia)`);
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO invoice_runs (factura_id, estado, payload_json, payload_hash)
           VALUES (?, 'BORRADOR', ?, ?)`,
        )
        .run(payload.factura_id, JSON.stringify(payload), payloadHash);
      const insLinea = this.db.prepare(
        `INSERT INTO invoice_lines
         (factura_id, cobro_id, descripcion, moneda, monto_neto_original, cantidad, precio_unitario_clp, total_linea_clp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const l of payload.lineas) {
        insLinea.run(
          payload.factura_id, l.cobro_id, l.descripcion, l.moneda,
          l.monto_neto_original, l.cantidad, l.precio_unitario_clp, l.total_linea_clp,
        );
      }
      this.db
        .prepare(`INSERT INTO state_events (factura_id, desde, hacia, detalle) VALUES (?, NULL, 'BORRADOR', 'creación')`)
        .run(payload.factura_id);
    });
    tx();
  }

  obtenerFactura(facturaId: string): FilaFactura | undefined {
    return this.db.prepare('SELECT * FROM invoice_runs WHERE factura_id = ?').get(facturaId) as
      | FilaFactura
      | undefined;
  }

  obtenerLineas(facturaId: string): LineaFactura[] {
    return this.db
      .prepare('SELECT * FROM invoice_lines WHERE factura_id = ? ORDER BY cobro_id')
      .all(facturaId) as LineaFactura[];
  }

  registrarTransicion(facturaId: string, hacia: Estado, detalle: string): void {
    const actual = this.obtenerFactura(facturaId);
    if (!actual) throw new Error(`Factura no encontrada: ${facturaId}`);
    assertTransicion(actual.estado, hacia);
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE invoice_runs SET estado = ? WHERE factura_id = ?').run(hacia, facturaId);
      this.db
        .prepare('INSERT INTO state_events (factura_id, desde, hacia, detalle) VALUES (?, ?, ?, ?)')
        .run(facturaId, actual.estado, hacia, detalle);
    });
    tx();
  }

  obtenerEventos(facturaId: string): EventoEstado[] {
    return this.db
      .prepare('SELECT * FROM state_events WHERE factura_id = ? ORDER BY id')
      .all(facturaId) as EventoEstado[];
  }

  registrarAprobacion(facturaId: string, actor: string, payloadHash: string, aprobadoEn: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO approvals (factura_id, actor, payload_hash, aprobado_en) VALUES (?, ?, ?, ?)')
      .run(facturaId, actor, payloadHash, aprobadoEn);
  }

  obtenerAprobacion(facturaId: string): { actor: string; payload_hash: string; aprobado_en: string } | undefined {
    return this.db.prepare('SELECT actor, payload_hash, aprobado_en FROM approvals WHERE factura_id = ?').get(facturaId) as
      | { actor: string; payload_hash: string; aprobado_en: string }
      | undefined;
  }

  registrarIntentoCorreo(facturaId: string, exito: boolean, detalle: string): void {
    this.db
      .prepare('INSERT INTO email_attempts (factura_id, exito, detalle) VALUES (?, ?, ?)')
      .run(facturaId, exito ? 1 : 0, detalle);
  }

  obtenerIntentosCorreo(facturaId: string): { exito: number; detalle: string }[] {
    return this.db
      .prepare('SELECT exito, detalle FROM email_attempts WHERE factura_id = ? ORDER BY id')
      .all(facturaId) as { exito: number; detalle: string }[];
  }

  guardarFolio(facturaId: string, folio: string): void {
    this.db.prepare('UPDATE invoice_runs SET folio_sii = ? WHERE factura_id = ?').run(folio, facturaId);
  }

  guardarRutaPdf(facturaId: string, ruta: string): void {
    this.db.prepare('UPDATE invoice_runs SET pdf_path = ? WHERE factura_id = ?').run(ruta, facturaId);
  }

  cerrar(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `pnpm vitest run tests/store/audit-store.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/audit-store.ts tests/store/audit-store.test.ts
git commit -m "feat: AuditStore SQLite con idempotencia y eventos de estado"
```

---

### Task 9: StorageService — rutas confinadas y PDF atómico

**Files:**
- Create: `src/services/storage.ts`
- Test: `tests/services/storage.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// tests/services/storage.test.ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  guardarPdf,
  rutaFactura,
  sanitizarNombreCarpeta,
} from '../../src/services/storage.js';

const PDF_MINIMO = Buffer.from('%PDF-1.4\n%%EOF\n');

describe('sanitizarNombreCarpeta', () => {
  it('elimina separadores, control y puntos iniciales', () => {
    expect(sanitizarNombreCarpeta('NCA')).toBe('NCA');
    expect(sanitizarNombreCarpeta('../etc')).toBe('etc');
    expect(sanitizarNombreCarpeta('a/b\\c')).toBe('abc');
  });
  it('rechaza nombres que quedan vacíos', () => {
    expect(() => sanitizarNombreCarpeta('../..')).toThrow(/nombre_carpeta/);
  });
});

describe('rutaFactura', () => {
  it('construye cliente/<carpeta>/<AAAA>/<MM>/Factura_<folio>_<cliente>_<AAAA-MM>.pdf', () => {
    const ruta = rutaFactura('/raiz/cliente', 'NCA', '2026-07-05', '12345', 'NCA');
    expect(ruta).toBe('/raiz/cliente/NCA/2026/07/Factura_12345_NCA_2026-07.pdf');
  });
  it('rechaza rutas que escapan de la raíz autorizada', () => {
    expect(() => rutaFactura('/raiz/cliente', '..', '2026-07-05', '1', 'X')).toThrow();
  });
});

describe('guardarPdf', () => {
  it('escribe de forma atómica y verifica cabecera PDF y tamaño', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'storage-'));
    const destino = join(raiz, 'sub', 'Factura_1_X_2026-07.pdf');
    await guardarPdf(destino, PDF_MINIMO);
    expect(readFileSync(destino).toString()).toContain('%PDF');
  });
  it('rechaza contenido que no es PDF o está vacío', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'storage-'));
    await expect(guardarPdf(join(raiz, 'a.pdf'), Buffer.from(''))).rejects.toThrow(/vacío/);
    await expect(guardarPdf(join(raiz, 'b.pdf'), Buffer.from('<html>'))).rejects.toThrow(/PDF/);
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `pnpm vitest run tests/services/storage.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 3: Implementación mínima**

```ts
// src/services/storage.ts
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export function sanitizarNombreCarpeta(nombre: string): string {
  const limpio = nombre
    .replace(/[/\\\0-\x1f]/g, '')
    .replace(/\.+/g, (m, offset: number) => (offset === 0 ? '' : m))
    .replace(/^\.+|\.+$/g, '')
    .trim();
  if (limpio.length === 0) throw new Error(`nombre_carpeta inválido tras sanear: "${nombre}"`);
  return limpio;
}

export function rutaFactura(
  raiz: string,
  nombreCarpeta: string,
  fechaEmision: string,
  folio: string,
  cliente: string,
): string {
  const carpeta = sanitizarNombreCarpeta(nombreCarpeta);
  const [anio, mes] = [fechaEmision.slice(0, 4), fechaEmision.slice(5, 7)];
  const periodo = `${anio}-${mes}`;
  const nombre = `Factura_${folio}_${sanitizarNombreCarpeta(cliente)}_${periodo}.pdf`;
  const ruta = resolve(join(raiz, carpeta, anio, mes, nombre));
  const raizResuelta = resolve(raiz);
  if (!ruta.startsWith(raizResuelta + sep)) {
    throw new Error(`Ruta fuera de la raíz autorizada: ${ruta}`);
  }
  return ruta;
}

export async function guardarPdf(destino: string, datos: Buffer): Promise<void> {
  if (datos.length === 0) throw new Error('El PDF descargado está vacío');
  if (!datos.subarray(0, 5).toString('latin1').startsWith('%PDF')) {
    throw new Error('El contenido descargado no es un PDF');
  }
  await mkdir(dirname(destino), { recursive: true });
  const temporal = `${destino}.tmp-${process.pid}`;
  await writeFile(temporal, datos);
  const info = await stat(temporal);
  if (info.size !== datos.length || info.size === 0) {
    throw new Error('Verificación de tamaño del PDF falló');
  }
  await rename(temporal, destino);
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `pnpm vitest run tests/services/storage.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/storage.ts tests/services/storage.test.ts
git commit -m "feat: almacenamiento confinado con escritura atómica y verificación PDF"
```

---

### Task 10: UfProvider — tabla oficial del SII

**Files:**
- Create: `src/adapters/uf/uf-provider.ts`
- Test: `tests/adapters/uf-provider.test.ts`, `tests/fixtures/uf2026.html`

- [ ] **Step 1: Crear el fixture sanitizado**

`tests/fixtures/uf2026.html` (estructura real de `https://www.sii.cl/valores_y_fechas/uf/uf2026.htm`: tablas por semestre, filas por día, columnas por mes; validar contra la página real durante la validación controlada y ajustar el parser si la estructura difiere):

```html
<html><body>
<table>
  <tr><th>Día</th><th>Ene</th><th>Feb</th><th>Mar</th><th>Abr</th><th>May</th><th>Jun</th></tr>
  <tr><th>1</th><td>39.100,10</td><td>39.150,20</td><td>39.200,30</td><td>39.250,40</td><td>39.300,50</td><td>39.350,60</td></tr>
  <tr><th>5</th><td>39.110,15</td><td>39.160,25</td><td>39.210,35</td><td>39.260,45</td><td>39.310,55</td><td>39.360,65</td></tr>
</table>
<table>
  <tr><th>Día</th><th>Jul</th><th>Ago</th><th>Sep</th><th>Oct</th><th>Nov</th><th>Dic</th></tr>
  <tr><th>1</th><td>39.400,70</td><td>39.450,80</td><td>39.500,90</td><td>39.551,00</td><td>39.601,10</td><td>39.651,20</td></tr>
  <tr><th>5</th><td>39.418,53</td><td>39.460,85</td><td>39.510,95</td><td>39.561,05</td><td>39.611,15</td><td>39.661,25</td></tr>
  <tr><th>31</th><td>39.440,00</td><td></td><td></td><td></td><td></td><td>39.700,00</td></tr>
</table>
</body></html>
```

- [ ] **Step 2: Escribir el test que falla**

```ts
// tests/adapters/uf-provider.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseMontoChileno,
  parseUfHtml,
  urlUfOficial,
  validarValorUf,
} from '../../src/adapters/uf/uf-provider.js';

const html = readFileSync(join(__dirname, '../fixtures/uf2026.html'), 'utf8');

describe('parseMontoChileno', () => {
  it('convierte formato chileno a número', () => {
    expect(parseMontoChileno('39.418,53')).toBe(39418.53);
    expect(parseMontoChileno('1.234.567')).toBe(1234567);
  });
  it('rechaza texto no numérico', () => {
    expect(() => parseMontoChileno('n/d')).toThrow(/monto/i);
  });
});

describe('urlUfOficial', () => {
  it('apunta al año de la fecha de emisión', () => {
    expect(urlUfOficial('2026-07-05')).toBe('https://www.sii.cl/valores_y_fechas/uf/uf2026.htm');
  });
});

describe('parseUfHtml', () => {
  it('extrae el valor exacto del día y mes solicitados', () => {
    expect(parseUfHtml(html, '2026-07-05')).toBe(39418.53);
    expect(parseUfHtml(html, '2026-02-01')).toBe(39150.2);
  });
  it('devuelve null si la fecha no existe en la tabla', () => {
    expect(parseUfHtml(html, '2026-08-31')).toBeNull();
    expect(parseUfHtml(html, '2026-07-09')).toBeNull();
  });
});

describe('validarValorUf', () => {
  it('acepta valores dentro del rango razonable', () => {
    expect(() => validarValorUf(39418.53)).not.toThrow();
  });
  it('bloquea valores fuera de rango', () => {
    expect(() => validarValorUf(500)).toThrow(/rango/);
    expect(() => validarValorUf(900000)).toThrow(/rango/);
  });
});
```

- [ ] **Step 3: Verificar que falla**

Run: `pnpm vitest run tests/adapters/uf-provider.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 4: Implementación mínima**

```ts
// src/adapters/uf/uf-provider.ts
import * as cheerio from 'cheerio';
import { conReintentos } from '../graph/reintentos.js';

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const UF_MIN = 10000;
const UF_MAX = 200000;

export interface ValorUfRegistrado {
  valor: number;
  fecha: string;
  url: string;
  consultadoEn: string;
}

export function parseMontoChileno(texto: string): number {
  const limpio = texto.trim();
  if (!/^\d{1,3}(\.\d{3})*(,\d+)?$/.test(limpio)) {
    throw new Error(`Monto chileno inválido: "${texto}"`);
  }
  return Number(limpio.replace(/\./g, '').replace(',', '.'));
}

export function urlUfOficial(fechaIso: string): string {
  return `https://www.sii.cl/valores_y_fechas/uf/uf${fechaIso.slice(0, 4)}.htm`;
}

export function parseUfHtml(html: string, fechaIso: string): number | null {
  const mes = Number(fechaIso.slice(5, 7));
  const dia = Number(fechaIso.slice(8, 10));
  const $ = cheerio.load(html);
  let valor: number | null = null;

  $('table').each((_, tabla) => {
    const filas = $(tabla).find('tr');
    const encabezados = filas
      .first()
      .find('th,td')
      .map((_, el) => $(el).text().trim())
      .get();
    const col = encabezados.findIndex((h) => h.startsWith(MESES[mes - 1] as string));
    if (col === -1) return;
    filas.slice(1).each((_, tr) => {
      const celdas = $(tr)
        .find('th,td')
        .map((_, el) => $(el).text().trim())
        .get();
      if (Number(celdas[0]) === dia && celdas[col]) {
        valor = parseMontoChileno(celdas[col] as string);
      }
    });
  });
  return valor;
}

export function validarValorUf(valor: number): void {
  if (!(valor >= UF_MIN && valor <= UF_MAX)) {
    throw new Error(`Valor UF fuera de rango razonable [${UF_MIN}, ${UF_MAX}]: ${valor}`);
  }
}

export class UfProvider {
  constructor(private readonly descargar: (url: string) => Promise<string> = descargarHtml) {}

  async obtenerValorUf(fechaIso: string): Promise<ValorUfRegistrado> {
    const url = urlUfOficial(fechaIso);
    const html = await conReintentos(() => this.descargar(url), { intentos: 3, baseMs: 500 });
    const valor = parseUfHtml(html, fechaIso);
    if (valor === null) {
      throw new Error(`No existe valor UF publicado para ${fechaIso} en ${url}; factura bloqueada`);
    }
    validarValorUf(valor);
    return { valor, fecha: fechaIso, url, consultadoEn: new Date().toISOString() };
  }
}

async function descargarHtml(url: string): Promise<string> {
  const respuesta = await fetch(url);
  if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status} al consultar ${url}`);
  return respuesta.text();
}
```

Nota: `conReintentos` se implementa en la Task 11; si se ejecuta esta task primero, crear `src/adapters/graph/reintentos.ts` con la implementación de la Task 11 Step 3 ahora y omitir su test hasta esa task — o ejecutar la Task 11 antes. Recomendado: ejecutar Task 11 antes que Task 10.

- [ ] **Step 5: Verificar que pasa**

Run: `pnpm vitest run tests/adapters/uf-provider.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add src/adapters/uf/uf-provider.ts tests/adapters/uf-provider.test.ts tests/fixtures/uf2026.html
git commit -m "feat: proveedor UF con parser de la tabla oficial del SII"
```

---

### Task 11: Reintentos con backoff y GraphClient

Nota: ejecutar esta task ANTES que la Task 10 (UfProvider importa `conReintentos`).

**Files:**
- Create: `src/adapters/graph/reintentos.ts`, `src/adapters/graph/graph-client.ts`
- Test: `tests/adapters/reintentos.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// tests/adapters/reintentos.test.ts
import { describe, expect, it, vi } from 'vitest';
import { conReintentos, EsReintentableError } from '../../src/adapters/graph/reintentos.js';

describe('conReintentos', () => {
  it('devuelve el resultado al primer intento exitoso', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(conReintentos(fn, { intentos: 3, baseMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reintenta hasta 3 veces ante errores reintentables', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new EsReintentableError('timeout'))
      .mockRejectedValueOnce(new EsReintentableError('timeout'))
      .mockResolvedValue('ok');
    await expect(conReintentos(fn, { intentos: 3, baseMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('agota los intentos y propaga el último error', async () => {
    const fn = vi.fn().mockRejectedValue(new EsReintentableError('caído'));
    await expect(conReintentos(fn, { intentos: 3, baseMs: 1 })).rejects.toThrow('caído');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('no reintenta errores no reintentables', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('400 Bad Request'));
    await expect(conReintentos(fn, { intentos: 3, baseMs: 1 })).rejects.toThrow('400');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `pnpm vitest run tests/adapters/reintentos.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 3: Implementar reintentos**

```ts
// src/adapters/graph/reintentos.ts
export class EsReintentableError extends Error {}

export interface OpcionesReintento {
  intentos: number;
  baseMs: number;
}

export async function conReintentos<T>(
  fn: () => Promise<T>,
  { intentos, baseMs }: OpcionesReintento,
): Promise<T> {
  let ultimoError: unknown;
  for (let intento = 1; intento <= intentos; intento++) {
    try {
      return await fn();
    } catch (error) {
      ultimoError = error;
      const reintentable =
        error instanceof EsReintentableError ||
        (error instanceof Error && /HTTP (429|5\d\d)|fetch failed|ETIMEDOUT|ECONNRESET/.test(error.message));
      if (!reintentable || intento === intentos) throw error;
      const espera = baseMs * 2 ** (intento - 1) * (1 + Math.random() * 0.3);
      await new Promise((r) => setTimeout(r, espera));
    }
  }
  throw ultimoError;
}
```

- [ ] **Step 4: Implementar GraphClient (autenticación device code, sin test unitario — se cubre con mocks en Tasks 12 y 14)**

```ts
// src/adapters/graph/graph-client.ts
import {
  PublicClientApplication,
  type AuthenticationResult,
} from '@azure/msal-node';
import { conReintentos } from './reintentos.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SCOPES = ['User.Read', 'Files.ReadWrite', 'Mail.Send', 'offline_access'];

export interface IGraphClient {
  solicitar<T>(metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE', ruta: string, cuerpo?: unknown): Promise<T>;
}

export class GraphClient implements IGraphClient {
  constructor(private readonly obtenerToken: () => Promise<string>) {}

  async solicitar<T>(metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE', ruta: string, cuerpo?: unknown): Promise<T> {
    return conReintentos(
      async () => {
        const token = await this.obtenerToken();
        const respuesta = await fetch(`${GRAPH_BASE}${ruta}`, {
          method: metodo,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
        });
        if (!respuesta.ok) {
          const detalle = await respuesta.text();
          // No incluir el token ni encabezados en el error.
          throw new Error(`HTTP ${respuesta.status} en ${metodo} ${ruta}: ${detalle.slice(0, 300)}`);
        }
        if (respuesta.status === 204) return undefined as T;
        return (await respuesta.json()) as T;
      },
      { intentos: 3, baseMs: 500 },
    );
  }
}

export function crearAutenticadorDeviceCode(opciones: {
  tenantId: string;
  clientId: string;
  cachePlugin?: import('@azure/msal-node').ICachePlugin;
}): () => Promise<string> {
  const pca = new PublicClientApplication({
    auth: {
      clientId: opciones.clientId,
      authority: `https://login.microsoftonline.com/${opciones.tenantId}`,
    },
    cache: opciones.cachePlugin ? { cachePlugin: opciones.cachePlugin } : undefined,
  });

  return async () => {
    const cuentas = await pca.getTokenCache().getAllAccounts();
    if (cuentas.length > 0) {
      try {
        const silencioso = await pca.acquireTokenSilent({ account: cuentas[0]!, scopes: SCOPES });
        if (silencioso?.accessToken) return silencioso.accessToken;
      } catch {
        // continúa con device code
      }
    }
    const resultado: AuthenticationResult | null = await pca.acquireTokenByDeviceCode({
      scopes: SCOPES,
      deviceCodeCallback: (info) => {
        // Instrucción para el operador humano; no contiene secretos.
        console.log(info.message);
      },
    });
    if (!resultado?.accessToken) throw new Error('No se pudo obtener token de Microsoft Graph');
    return resultado.accessToken;
  };
}
```

- [ ] **Step 5: Verificar que pasa**

Run: `pnpm vitest run tests/adapters/reintentos.test.ts && pnpm typecheck`
Expected: PASS (4 tests) y typecheck limpio.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/graph/reintentos.ts src/adapters/graph/graph-client.ts tests/adapters/reintentos.test.ts
git commit -m "feat: reintentos con backoff y cliente Graph con device code"
```

---

### Task 12: ExcelAdapter — lectura de tablas y escritura de tblFacturas

**Files:**
- Create: `src/adapters/excel/excel-adapter.ts`
- Test: `tests/adapters/excel-adapter.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// tests/adapters/excel-adapter.test.ts
import { describe, expect, it, vi } from 'vitest';
import { ENCABEZADOS, ExcelAdapter } from '../../src/adapters/excel/excel-adapter.js';
import type { IGraphClient } from '../../src/adapters/graph/graph-client.js';

function graphFalso(respuestas: Record<string, unknown>): IGraphClient & { solicitar: ReturnType<typeof vi.fn> } {
  const solicitar = vi.fn(async (_metodo: string, ruta: string, _cuerpo?: unknown) => {
    for (const [clave, valor] of Object.entries(respuestas)) {
      if (ruta.includes(clave)) return valor;
    }
    throw new Error(`Ruta no esperada en el test: ${ruta}`);
  });
  return { solicitar } as unknown as IGraphClient & { solicitar: ReturnType<typeof vi.fn> };
}

const cfg = { driveId: 'D1', itemId: 'I1' };

describe('ExcelAdapter.leerTabla', () => {
  it('convierte filas de Graph en objetos usando los encabezados', async () => {
    const graph = graphFalso({
      "tables/tblEmpresas/headerRowRange": { values: [ENCABEZADOS.tblEmpresas] },
      "tables/tblEmpresas/rows": {
        value: [{ values: [['E1', '12.345.678-5', 'Emisora SpA', 'f@e.cl', 'c@e.cl', 'TRUE']] }],
      },
    });
    const adaptador = new ExcelAdapter(graph, cfg);
    const filas = await adaptador.leerTabla('tblEmpresas');
    expect(filas).toEqual([
      {
        empresa_id: 'E1',
        rut_emisor: '12.345.678-5',
        razon_social: 'Emisora SpA',
        email_remitente: 'f@e.cl',
        email_copia: 'c@e.cl',
        activo: 'TRUE',
      },
    ]);
  });

  it('rechaza encabezados que no coinciden exactamente', async () => {
    const graph = graphFalso({
      'tables/tblEmpresas/headerRowRange': { values: [['empresa_id', 'rut', 'x', 'y', 'z', 'w']] },
    });
    const adaptador = new ExcelAdapter(graph, cfg);
    await expect(adaptador.leerTabla('tblEmpresas')).rejects.toThrow(/Encabezados/);
  });

  it('rechaza nombres de tabla no conocidos', async () => {
    const adaptador = new ExcelAdapter(graphFalso({}), cfg);
    await expect(adaptador.leerTabla('tblOtra')).rejects.toThrow(/tabla/i);
  });
});

describe('ExcelAdapter.agregarFilaFacturas', () => {
  it('envía la fila en el orden exacto de encabezados de tblFacturas', async () => {
    const graph = graphFalso({ 'tables/tblFacturas/rows/add': {} });
    const adaptador = new ExcelAdapter(graph, cfg);
    await adaptador.agregarFilaFacturas({
      factura_id: 'RECURRENT:E1:CL1:2026-07',
      cobro_id: 'C1;C2',
      periodo: '2026-07',
      fecha_emision: '2026-07-05',
      valor_uf: '39418.53',
      monto_neto_clp: '1320521',
      iva_clp: '250899',
      total_clp: '1571420',
      folio_sii: '',
      estado: 'BORRADOR',
      pdf_path: '',
      aprobada_por: '',
      fecha_aprobacion: '',
      fecha_envio: '',
      error: '',
    });
    const llamada = graph.solicitar.mock.calls.find((c) => String(c[1]).includes('rows/add'));
    expect(llamada?.[0]).toBe('POST');
    expect((llamada?.[2] as { values: string[][] }).values[0]).toEqual([
      'RECURRENT:E1:CL1:2026-07', 'C1;C2', '2026-07', '2026-07-05', '39418.53',
      '1320521', '250899', '1571420', '', 'BORRADOR', '', '', '', '', '',
    ]);
  });
});

describe('ExcelAdapter.actualizarFilaFacturas', () => {
  it('localiza la fila por factura_id y aplica solo los cambios', async () => {
    const graph = graphFalso({
      'tables/tblFacturas/headerRowRange': { values: [ENCABEZADOS.tblFacturas] },
      'tables/tblFacturas/rows': {
        value: [
          { index: 0, values: [['RECURRENT:E1:CL1:2026-07', 'C1', '2026-07', '2026-07-05', '', '100', '19', '119', '', 'BORRADOR', '', '', '', '', '']] },
        ],
      },
      'range/insert': {},
      "rows/itemAt(index=0)": {},
    });
    const adaptador = new ExcelAdapter(graph, cfg);
    await adaptador.actualizarFilaFacturas('RECURRENT:E1:CL1:2026-07', {
      estado: 'EMITIDA',
      folio_sii: '12345',
    });
    const patch = graph.solicitar.mock.calls.find((c) => c[0] === 'PATCH');
    const valores = (patch?.[2] as { values: string[][] }).values[0]!;
    expect(valores[9]).toBe('EMITIDA');
    expect(valores[8]).toBe('12345');
  });

  it('lanza si la factura no existe en tblFacturas', async () => {
    const graph = graphFalso({
      'tables/tblFacturas/headerRowRange': { values: [ENCABEZADOS.tblFacturas] },
      'tables/tblFacturas/rows': { value: [] },
    });
    const adaptador = new ExcelAdapter(graph, cfg);
    await expect(adaptador.actualizarFilaFacturas('NO-EXISTE', { estado: 'EMITIDA' })).rejects.toThrow(
      /no encontrada/i,
    );
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `pnpm vitest run tests/adapters/excel-adapter.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 3: Implementación mínima**

```ts
// src/adapters/excel/excel-adapter.ts
import type { IGraphClient } from '../graph/graph-client.js';

export const ENCABEZADOS = {
  tblEmpresas: ['empresa_id', 'rut_emisor', 'razon_social', 'email_remitente', 'email_copia', 'activo'],
  tblClientes: [
    'cliente_id', 'razon_social', 'nombre_carpeta', 'rut_cliente', 'email_facturacion',
    'giro', 'direccion', 'comuna', 'ciudad', 'activo',
  ],
  tblCobrosRecurrentes: [
    'cobro_id', 'empresa_id', 'cliente_id', 'descripcion_servicio', 'moneda', 'monto_neto',
    'cantidad', 'frecuencia', 'dia_emision', 'forma_pago', 'dias_vencimiento',
    'fecha_inicio', 'fecha_fin', 'activo',
  ],
  tblFacturas: [
    'factura_id', 'cobro_id', 'periodo', 'fecha_emision', 'valor_uf', 'monto_neto_clp',
    'iva_clp', 'total_clp', 'folio_sii', 'estado', 'pdf_path', 'aprobada_por',
    'fecha_aprobacion', 'fecha_envio', 'error',
  ],
} as const;

export type NombreTabla = keyof typeof ENCABEZADOS;
export type FilaFacturasExcel = Record<(typeof ENCABEZADOS.tblFacturas)[number], string>;

interface FilaGraph {
  index?: number;
  values: string[][];
}

export class ExcelAdapter {
  constructor(
    private readonly graph: IGraphClient,
    private readonly cfg: { driveId: string; itemId: string },
  ) {}

  private base(): string {
    return `/drives/${this.cfg.driveId}/items/${this.cfg.itemId}/workbook`;
  }

  private async validarEncabezados(tabla: NombreTabla): Promise<string[]> {
    const esperados = ENCABEZADOS[tabla] as readonly string[];
    const rango = await this.graph.solicitar<{ values: string[][] }>(
      'GET',
      `${this.base()}/tables/${tabla}/headerRowRange`,
    );
    const reales = (rango.values[0] ?? []).map((v) => String(v).trim());
    if (reales.length !== esperados.length || reales.some((v, i) => v !== esperados[i])) {
      throw new Error(
        `Encabezados de ${tabla} no coinciden. Esperados: [${esperados.join(', ')}]. Reales: [${reales.join(', ')}]`,
      );
    }
    return [...esperados];
  }

  async leerTabla(tabla: string): Promise<Record<string, string>[]> {
    if (!(tabla in ENCABEZADOS)) throw new Error(`Nombre de tabla no autorizado: ${tabla}`);
    const nombre = tabla as NombreTabla;
    const encabezados = await this.validarEncabezados(nombre);
    const filas = await this.graph.solicitar<{ value: FilaGraph[] }>(
      'GET',
      `${this.base()}/tables/${nombre}/rows`,
    );
    return filas.value.map((fila) => {
      const valores = fila.values[0] ?? [];
      const objeto: Record<string, string> = {};
      encabezados.forEach((clave, i) => {
        objeto[clave] = valores[i] === undefined || valores[i] === null ? '' : String(valores[i]);
      });
      return objeto;
    });
  }

  async agregarFilaFacturas(fila: FilaFacturasExcel): Promise<void> {
    const valores = ENCABEZADOS.tblFacturas.map((clave) => fila[clave] ?? '');
    await this.graph.solicitar('POST', `${this.base()}/tables/tblFacturas/rows/add`, {
      values: [valores],
    });
  }

  async actualizarFilaFacturas(facturaId: string, cambios: Partial<FilaFacturasExcel>): Promise<void> {
    await this.validarEncabezados('tblFacturas');
    const filas = await this.graph.solicitar<{ value: FilaGraph[] }>(
      'GET',
      `${this.base()}/tables/tblFacturas/rows`,
    );
    const indice = filas.value.findIndex((f) => (f.values[0] ?? [])[0] === facturaId);
    if (indice === -1) throw new Error(`Fila no encontrada en tblFacturas: ${facturaId}`);
    const actuales = [...(filas.value[indice]!.values[0] ?? [])].map((v) => (v == null ? '' : String(v)));
    ENCABEZADOS.tblFacturas.forEach((clave, i) => {
      if (cambios[clave] !== undefined) actuales[i] = cambios[clave] as string;
    });
    await this.graph.solicitar('PATCH', `${this.base()}/tables/tblFacturas/rows/itemAt(index=${indice})`, {
      values: [actuales],
    });
  }
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `pnpm vitest run tests/adapters/excel-adapter.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/excel/excel-adapter.ts tests/adapters/excel-adapter.test.ts
git commit -m "feat: adaptador Excel con validación de encabezados y escritura en tblFacturas"
```

---

### Task 13: ApprovalService — APROBAR <factura_id> con hash y expiración

**Files:**
- Create: `src/services/aprobacion.ts`
- Test: `tests/services/aprobacion.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// tests/services/aprobacion.test.ts
import { describe, expect, it } from 'vitest';
import { ApprovalService, resumenAprobacion } from '../../src/services/aprobacion.js';
import { hashPayload } from '../../src/domain/hash.js';
import type { InvoicePayload } from '../../src/domain/tipos.js';

const payload: InvoicePayload = {
  factura_id: 'RECURRENT:E1:CL1:2026-07',
  empresa_id: 'E1',
  rut_emisor: '12345678-5',
  razon_social_emisor: 'Emisora SpA',
  cliente_id: 'CL1',
  rut_cliente: '11111111-1',
  razon_social_cliente: 'Cliente Ltda',
  nombre_carpeta: 'NCA',
  periodo: '2026-07',
  fecha_emision: '2026-07-05',
  fecha_vencimiento: '2026-07-05',
  forma_pago: 'CONTADO',
  tipo_venta: 'Del Giro',
  tipo_compra: 'Del Giro',
  valor_uf: null,
  lineas: [
    {
      cobro_id: 'C1', descripcion: 'Servicio', moneda: 'CLP',
      monto_neto_original: 100000, cantidad: 1, precio_unitario_clp: 100000, total_linea_clp: 100000,
    },
  ],
  neto_clp: 100000,
  iva_clp: 19000,
  total_clp: 119000,
  remitente: 'facturas@empresa.cl',
  destinatarios: ['pagos@cliente.cl'],
  copia: ['copia@empresa.cl'],
};

function servicio(respuesta: string | null) {
  const io = {
    pregunta: async () => {
      if (respuesta === null) throw new Error('expirada');
      return respuesta;
    },
  };
  return new ApprovalService(io, () => new Date('2026-07-05T10:00:00Z'), 'andres');
}

describe('resumenAprobacion', () => {
  it('muestra totales, destinatarios y RUT oculto, nunca el RUT completo', () => {
    const texto = resumenAprobacion(payload, '/raiz/cliente/NCA/2026/07/x.pdf');
    expect(texto).toContain('Emisora SpA');
    expect(texto).toContain('11******-1');
    expect(texto).not.toContain('11111111-1');
    expect(texto).toContain('119.000');
    expect(texto).toContain('pagos@cliente.cl');
  });
});

describe('ApprovalService', () => {
  it('aprueba solo con el texto exacto APROBAR <factura_id>', async () => {
    const r = await servicio(`APROBAR ${payload.factura_id}`).solicitarAprobacion(payload, '/ruta.pdf');
    expect(r.aprobada).toBe(true);
    expect(r.hash).toBe(hashPayload(payload));
    expect(r.actor).toBe('andres');
    expect(r.fecha).toBe('2026-07-05T10:00:00.000Z');
  });

  it('rechaza cualquier otra respuesta', async () => {
    for (const texto of ['aprobar', 'APROBAR otra-id', 'si', '']) {
      const r = await servicio(texto).solicitarAprobacion(payload, '/ruta.pdf');
      expect(r.aprobada).toBe(false);
    }
  });

  it('valida el hash vigente antes de emitir', () => {
    const s = servicio('x');
    const hash = hashPayload(payload);
    expect(s.hashVigente(payload, hash)).toBe(true);
    expect(s.hashVigente({ ...payload, total_clp: 1 }, hash)).toBe(false);
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `pnpm vitest run tests/services/aprobacion.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 3: Implementación mínima**

```ts
// src/services/aprobacion.ts
import { hashPayload } from '../domain/hash.js';
import { ocultarRut } from '../domain/rut.js';
import type { InvoicePayload } from '../domain/tipos.js';

export interface IoAprobacion {
  pregunta(mensaje: string): Promise<string>;
}

export interface ResultadoAprobacion {
  aprobada: boolean;
  hash: string;
  actor: string;
  fecha: string;
}

const formatoClp = new Intl.NumberFormat('es-CL');

export function resumenAprobacion(payload: InvoicePayload, rutaPrevista: string): string {
  const lineas = payload.lineas
    .map(
      (l) =>
        `  - ${l.descripcion} | ${l.cantidad} x ${l.moneda} ${l.monto_neto_original}` +
        ` = $${formatoClp.format(l.total_linea_clp)} CLP`,
    )
    .join('\n');
  return [
    `Factura: ${payload.factura_id}`,
    `Emisor: ${payload.razon_social_emisor} (${ocultarRut(payload.rut_emisor)})`,
    `Cliente: ${payload.razon_social_cliente} (${ocultarRut(payload.rut_cliente)})`,
    `Período: ${payload.periodo} | Emisión: ${payload.fecha_emision} | Vence: ${payload.fecha_vencimiento} (${payload.forma_pago})`,
    payload.valor_uf === null ? 'UF: no aplica' : `UF del día: ${payload.valor_uf}`,
    'Líneas:',
    lineas,
    `Neto: $${formatoClp.format(payload.neto_clp)} | IVA: $${formatoClp.format(payload.iva_clp)} | Total: $${formatoClp.format(payload.total_clp)}`,
    `Remitente: ${payload.remitente}`,
    `Para: ${payload.destinatarios.join('; ')} | CC: ${payload.copia.join('; ')}`,
    `PDF previsto: ${rutaPrevista}`,
  ].join('\n');
}

export class ApprovalService {
  constructor(
    private readonly io: IoAprobacion,
    private readonly ahora: () => Date,
    private readonly actor: string,
  ) {}

  async solicitarAprobacion(payload: InvoicePayload, rutaPrevista: string): Promise<ResultadoAprobacion> {
    const hash = hashPayload(payload);
    const mensaje =
      `${resumenAprobacion(payload, rutaPrevista)}\n\n` +
      `Para aprobar escriba exactamente: APROBAR ${payload.factura_id}\n> `;
    const respuesta = (await this.io.pregunta(mensaje)).trim();
    const aprobada = respuesta === `APROBAR ${payload.factura_id}`;
    return { aprobada, hash, actor: this.actor, fecha: this.ahora().toISOString() };
  }

  hashVigente(payload: InvoicePayload, hashAprobado: string): boolean {
    return hashPayload(payload) === hashAprobado;
  }
}
```

Nota de integración (CLI, Task 18): la expiración se implementa envolviendo `io.pregunta` con `AbortSignal.timeout(config.timeoutAprobacionMs)` en `readline`; si expira, la factura queda en `PENDIENTE_APROBACION` y el comando termina sin emitir.

- [ ] **Step 4: Verificar que pasa**

Run: `pnpm vitest run tests/services/aprobacion.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/aprobacion.ts tests/services/aprobacion.test.ts
git commit -m "feat: aprobación humana con texto exacto y hash del payload"
```

---

### Task 14: MailService — envío desde alias con adjunto

**Files:**
- Create: `src/services/correo.ts`
- Test: `tests/services/correo.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// tests/services/correo.test.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MailService } from '../../src/services/correo.js';
import type { IGraphClient } from '../../src/adapters/graph/graph-client.js';

function crearPdf(): string {
  const dir = mkdtempSync(join(tmpdir(), 'correo-'));
  const ruta = join(dir, 'Factura_12345_NCA_2026-07.pdf');
  writeFileSync(ruta, '%PDF-1.4\n%%EOF\n');
  return ruta;
}

describe('MailService.enviarFactura', () => {
  it('envía por Graph desde el alias con destinatarios, copia y adjunto', async () => {
    const solicitar = vi.fn().mockResolvedValue(undefined);
    const graph = { solicitar } as unknown as IGraphClient;
    const servicio = new MailService(graph, 'buzon@empresa.cl');
    const rutaPdf = crearPdf();

    await servicio.enviarFactura({
      remitente: 'facturas@empresa.cl',
      destinatarios: ['pagos@cliente.cl', 'finanzas@cliente.cl'],
      copia: ['copia@empresa.cl'],
      asunto: 'Factura 12345 — julio 2026',
      cuerpo: 'Adjuntamos la factura del período.',
      rutaPdf,
    });

    expect(solicitar).toHaveBeenCalledTimes(1);
    const [metodo, ruta, cuerpo] = solicitar.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(metodo).toBe('POST');
    expect(ruta).toBe('/users/buzon@empresa.cl/sendMail');
    const mensaje = (cuerpo as { message: Record<string, unknown> }).message;
    expect(mensaje.from).toEqual({ emailAddress: { address: 'facturas@empresa.cl' } });
    expect(mensaje.toRecipients).toEqual([
      { emailAddress: { address: 'pagos@cliente.cl' } },
      { emailAddress: { address: 'finanzas@cliente.cl' } },
    ]);
    expect(mensaje.ccRecipients).toEqual([{ emailAddress: { address: 'copia@empresa.cl' } }]);
    const adjuntos = mensaje.attachments as { name: string; contentBytes: string }[];
    expect(adjuntos[0]?.name).toBe('Factura_12345_NCA_2026-07.pdf');
    expect(Buffer.from(adjuntos[0]!.contentBytes, 'base64').toString()).toContain('%PDF');
    expect((cuerpo as { saveToSentItems: boolean }).saveToSentItems).toBe(true);
  });

  it('rechaza adjuntar un archivo que no es PDF', async () => {
    const graph = { solicitar: vi.fn() } as unknown as IGraphClient;
    const servicio = new MailService(graph, 'buzon@empresa.cl');
    const dir = mkdtempSync(join(tmpdir(), 'correo-'));
    const rutaNoPdf = join(dir, 'x.pdf');
    writeFileSync(rutaNoPdf, '<html>');
    await expect(
      servicio.enviarFactura({
        remitente: 'f@e.cl', destinatarios: ['a@b.cl'], copia: [],
        asunto: 'x', cuerpo: 'x', rutaPdf: rutaNoPdf,
      }),
    ).rejects.toThrow(/PDF/);
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `pnpm vitest run tests/services/correo.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 3: Implementación mínima**

```ts
// src/services/correo.ts
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { IGraphClient } from '../adapters/graph/graph-client.js';

export interface EnvioFactura {
  remitente: string;
  destinatarios: string[];
  copia: string[];
  asunto: string;
  cuerpo: string;
  rutaPdf: string;
}

export class MailService {
  constructor(
    private readonly graph: IGraphClient,
    private readonly buzonPrincipal: string,
  ) {}

  async enviarFactura(envio: EnvioFactura): Promise<void> {
    const datos = await readFile(envio.rutaPdf);
    if (!datos.subarray(0, 5).toString('latin1').startsWith('%PDF')) {
      throw new Error(`El adjunto no es un PDF válido: ${envio.rutaPdf}`);
    }
    const aDireccion = (correo: string) => ({ emailAddress: { address: correo } });
    await this.graph.solicitar('POST', `/users/${this.buzonPrincipal}/sendMail`, {
      message: {
        subject: envio.asunto,
        body: { contentType: 'Text', content: envio.cuerpo },
        from: aDireccion(envio.remitente),
        toRecipients: envio.destinatarios.map(aDireccion),
        ccRecipients: envio.copia.map(aDireccion),
        attachments: [
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: basename(envio.rutaPdf),
            contentType: 'application/pdf',
            contentBytes: datos.toString('base64'),
          },
        ],
      },
      saveToSentItems: true,
    });
  }
}
```

Regla operativa (se aplica en el CLI, Task 18): si Graph devuelve error de alias no permitido (403/ErrorSendAsDenied), la factura queda en `DESCARGADA`/`ERROR_REINTENTABLE` y NUNCA se vuelve a invocar `SiiAdapter`; `retry-email` solo reintenta este servicio.

- [ ] **Step 4: Verificar que pasa**

Run: `pnpm vitest run tests/services/correo.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/correo.ts tests/services/correo.test.ts
git commit -m "feat: envío de factura por Graph desde alias con adjunto PDF"
```

---

### Task 15: Adaptador SII — parse, selectores y Playwright

**Files:**
- Create: `src/adapters/sii/parse.ts`, `src/adapters/sii/selectores.ts`, `src/adapters/sii/sii-adapter.ts`
- Test: `tests/adapters/sii-parse.test.ts`

Las pruebas automáticas cubren SOLO la lógica pura (`parse.ts`). El flujo Playwright se valida manualmente con `preview-sii` (validación controlada del diseño §11); nunca en tests automáticos.

- [ ] **Step 1: Escribir el test que falla**

```ts
// tests/adapters/sii-parse.test.ts
import { describe, expect, it } from 'vitest';
import { compararTotales } from '../../src/adapters/sii/parse.js';

describe('compararTotales', () => {
  const esperado = { netoClp: 1320521, ivaClp: 250899, totalClp: 1571420 };

  it('coincide cuando los tres montos son exactamente iguales', () => {
    const r = compararTotales(esperado, { netoClp: 1320521, ivaClp: 250899, totalClp: 1571420 });
    expect(r.coinciden).toBe(true);
    expect(r.diferencias).toHaveLength(0);
  });

  it('reporta cada diferencia exacta y no coincide', () => {
    const r = compararTotales(esperado, { netoClp: 1320521, ivaClp: 250898, totalClp: 1571419 });
    expect(r.coinciden).toBe(false);
    expect(r.diferencias).toEqual([
      'iva: esperado 250899, SII muestra 250898',
      'total: esperado 1571420, SII muestra 1571419',
    ]);
  });
});
```

(`parseMontoChileno` ya se probó en Task 10; aquí se reutiliza el mismo módulo.)

- [ ] **Step 2: Verificar que falla**

Run: `pnpm vitest run tests/adapters/sii-parse.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 3: Implementar parse.ts**

```ts
// src/adapters/sii/parse.ts
export { parseMontoChileno } from '../uf/uf-provider.js';

export interface TotalesSii {
  netoClp: number;
  ivaClp: number;
  totalClp: number;
}

export function compararTotales(
  esperado: TotalesSii,
  mostrado: TotalesSii,
): { coinciden: boolean; diferencias: string[] } {
  const diferencias: string[] = [];
  const campos: [string, number, number][] = [
    ['neto', esperado.netoClp, mostrado.netoClp],
    ['iva', esperado.ivaClp, mostrado.ivaClp],
    ['total', esperado.totalClp, mostrado.totalClp],
  ];
  for (const [nombre, esp, real] of campos) {
    if (esp !== real) diferencias.push(`${nombre}: esperado ${esp}, SII muestra ${real}`);
  }
  return { coinciden: diferencias.length === 0, diferencias };
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `pnpm vitest run tests/adapters/sii-parse.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Implementar selectores.ts (centralizados, roles/texto antes que CSS)**

Los valores exactos se capturan en la primera sesión real de `preview-sii` y se corrigen aquí; el resto del código solo referencia este módulo:

```ts
// src/adapters/sii/selectores.ts
// Localizadores centralizados del Sistema de Facturación Gratuito del SII.
// Regla: roles y texto visible estable antes que selectores CSS frágiles.
// Verificar y ajustar en la primera sesión real de `preview-sii`.
export const SELECTORES = {
  urlPortal: 'https://www.sii.cl/servicios_online/1039-.html',
  urlEmisionFactura: 'https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi?DESDE_DONDE_URL=OPCION%3D2%26TIPO%3D4',
  selectorEmpresa: { rol: 'combobox', nombre: /empresa/i },
  campoRutReceptor: { etiqueta: /rut/i },
  campoRazonSocial: { etiqueta: /raz[oó]n social/i },
  campoGiro: { etiqueta: /giro/i },
  campoDireccion: { etiqueta: /direcci[oó]n/i },
  campoComuna: { etiqueta: /comuna/i },
  campoCiudad: { etiqueta: /ciudad/i },
  tipoVenta: { etiqueta: /tipo de venta/i },
  tipoCompra: { etiqueta: /tipo de compra/i },
  formaPagoContado: { texto: /contado/i },
  formaPagoCredito: { texto: /cr[eé]dito/i },
  lineaDescripcion: (fila: number) => ({ nombre: new RegExp(`detalle|descripcion`, 'i'), fila }),
  lineaCantidad: (fila: number) => ({ nombre: /cantidad/i, fila }),
  lineaPrecio: (fila: number) => ({ nombre: /precio/i, fila }),
  botonAgregarLinea: { rol: 'button', nombre: /agregar/i },
  botonVistaPrevia: { rol: 'button', nombre: /vista previa|validar/i },
  previewNeto: { texto: /monto neto/i },
  previewIva: { texto: /iva/i },
  previewTotal: { texto: /total/i },
  botonEmitir: { rol: 'button', nombre: /firmar y enviar|emitir/i },
  folioEnConfirmacion: /folio\s*n?[°º]?\s*(\d+)/i,
  enlacePdf: { rol: 'link', nombre: /ver documento|pdf/i },
  urlDocumentosEmitidos: 'https://www1.sii.cl/cgi-bin/Portal001/mipeDocsEmit.cgi',
} as const;
```

- [ ] **Step 6: Implementar sii-adapter.ts detrás de una interfaz**

```ts
// src/adapters/sii/sii-adapter.ts
import { chromium, type Browser, type Page } from 'playwright';
import { compararTotales, parseMontoChileno, type TotalesSii } from './parse.js';
import { SELECTORES } from './selectores.js';
import type { InvoicePayload } from '../../domain/tipos.js';

export interface ResultadoPreview {
  totales: TotalesSii;
  coinciden: boolean;
  diferencias: string[];
}

export interface ResultadoEmision {
  folio: string;
  pdf: Buffer;
}

export interface ISiiAdapter {
  abrirYPreparar(payload: InvoicePayload): Promise<void>;
  extraerPreview(payload: InvoicePayload): Promise<ResultadoPreview>;
  emitirUnaVez(): Promise<ResultadoEmision>;
  consultarDocumentosEmitidos(rutReceptor: string, fecha: string): Promise<string | null>;
  cerrar(): Promise<void>;
}

export class SiiAdapterPlaywright implements ISiiAdapter {
  private navegador: Browser | null = null;
  private pagina: Page | null = null;

  constructor(
    private readonly opciones: {
      dirEvidencia: string; // .data/evidence
      timeoutMs: number;
    },
  ) {}

  private async paginaActiva(): Promise<Page> {
    if (this.pagina) return this.pagina;
    // Navegador VISIBLE: el operador humano completa credencial/certificado/MFA.
    // El agente NUNCA evade CAPTCHA ni MFA (diseño §3.5).
    this.navegador = await chromium.launch({ headless: false });
    const contexto = await this.navegador.newContext();
    this.pagina = await contexto.newPage();
    this.pagina.setDefaultTimeout(this.opciones.timeoutMs);
    return this.pagina;
  }

  async abrirYPreparar(payload: InvoicePayload): Promise<void> {
    const pagina = await this.paginaActiva();
    await pagina.goto(SELECTORES.urlEmisionFactura);
    // Espera a que el operador esté autenticado (heurística: aparece el formulario).
    await pagina.getByLabel(SELECTORES.campoRutReceptor.etiqueta).waitFor({ timeout: this.opciones.timeoutMs });

    await pagina.getByLabel(SELECTORES.campoRutReceptor.etiqueta).fill(payload.rut_cliente);
    await pagina.getByLabel(SELECTORES.tipoVenta.etiqueta).selectOption({ label: payload.tipo_venta });
    await pagina.getByLabel(SELECTORES.tipoCompra.etiqueta).selectOption({ label: payload.tipo_compra });

    for (const [i, linea] of payload.lineas.entries()) {
      if (i > 0) await pagina.getByRole('button', { name: SELECTORES.botonAgregarLinea.nombre }).click();
      const fila = pagina.locator('tr.linea-detalle').nth(i);
      await fila.getByRole('textbox', { name: SELECTORES.lineaDescripcion(i).nombre }).fill(linea.descripcion);
      await fila.getByRole('textbox', { name: SELECTORES.lineaCantidad(i).nombre }).fill(String(linea.cantidad));
      await fila.getByRole('textbox', { name: SELECTORES.lineaPrecio(i).nombre }).fill(String(linea.precio_unitario_clp));
    }
    await pagina.getByRole('button', { name: SELECTORES.botonVistaPrevia.nombre }).click();
  }

  async extraerPreview(payload: InvoicePayload): Promise<ResultadoPreview> {
    const pagina = await this.paginaActiva();
    const leerMonto = async (patron: RegExp): Promise<number> => {
      const fila = pagina.getByText(patron).locator('xpath=ancestor::tr[1]');
      const texto = (await fila.innerText()).replace(/\s+/g, ' ');
      const m = /([\d.]+(?:,\d+)?)\s*$/.exec(texto.trim());
      if (!m) throw new Error(`No se pudo leer el monto para ${patron}`);
      return parseMontoChileno(m[1] as string);
    };
    const totales: TotalesSii = {
      netoClp: await leerMonto(SELECTORES.previewNeto.texto),
      ivaClp: await leerMonto(SELECTORES.previewIva.texto),
      totalClp: await leerMonto(SELECTORES.previewTotal.texto),
    };
    await pagina.screenshot({
      path: `${this.opciones.dirEvidencia}/preview-${payload.factura_id.replaceAll(':', '_')}.png`,
      fullPage: true,
    });
    const comparacion = compararTotales(
      { netoClp: payload.neto_clp, ivaClp: payload.iva_clp, totalClp: payload.total_clp },
      totales,
    );
    return { totales, ...comparacion };
  }

  async emitirUnaVez(): Promise<ResultadoEmision> {
    const pagina = await this.paginaActiva();
    // ÚNICA acción de emisión. Sin reintentos automáticos (diseño §10).
    await pagina.getByRole('button', { name: SELECTORES.botonEmitir.nombre }).click();
    await pagina.waitForLoadState('networkidle');
    const texto = await pagina.innerText('body');
    const m = SELECTORES.folioEnConfirmacion.exec(texto);
    if (!m) throw new Error('RESPUESTA_INCIERTA: no se encontró folio en la confirmación');
    const folio = m[1] as string;
    const [descarga] = await Promise.all([
      pagina.waitForEvent('download'),
      pagina.getByRole('link', { name: SELECTORES.enlacePdf.nombre }).first().click(),
    ]);
    const rutaTmp = await descarga.path();
    const { readFile } = await import('node:fs/promises');
    return { folio, pdf: await readFile(rutaTmp) };
  }

  async consultarDocumentosEmitidos(rutReceptor: string, fecha: string): Promise<string | null> {
    const pagina = await this.paginaActiva();
    await pagina.goto(SELECTORES.urlDocumentosEmitidos);
    await pagina.waitForLoadState('networkidle');
    const texto = await pagina.innerText('body');
    const patron = new RegExp(`${rutReceptor.split('-')[0]}[\\s\\S]{0,120}?folio\\s*n?[°º]?\\s*(\\d+)`, 'i');
    const m = patron.exec(texto);
    void fecha; // la fecha se verifica visualmente en el navegador visible
    return m ? (m[1] as string) : null;
  }

  async cerrar(): Promise<void> {
    await this.navegador?.close();
    this.navegador = null;
    this.pagina = null;
  }
}
```

- [ ] **Step 7: Verificar tipos y suite completa**

Run: `pnpm typecheck && pnpm test`
Expected: sin errores; todos los tests previos siguen en verde.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/sii tests/adapters/sii-parse.test.ts
git commit -m "feat: adaptador SII con selectores centralizados y emisión única"
```

---

### Task 16: FacturasRepository — espejo Excel y reconciliación

**Files:**
- Create: `src/store/facturas-repository.ts`
- Test: `tests/store/facturas-repository.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// tests/store/facturas-repository.test.ts
import { describe, expect, it, vi } from 'vitest';
import { FacturasRepository, filaExcelDesdePayload } from '../../src/store/facturas-repository.js';
import { AuditStore } from '../../src/store/audit-store.js';
import type { ExcelAdapter } from '../../src/adapters/excel/excel-adapter.js';
import type { InvoicePayload } from '../../src/domain/tipos.js';

const payload: InvoicePayload = {
  factura_id: 'RECURRENT:E1:CL1:2026-07',
  empresa_id: 'E1',
  rut_emisor: '12345678-5',
  razon_social_emisor: 'Emisora SpA',
  cliente_id: 'CL1',
  rut_cliente: '11111111-1',
  razon_social_cliente: 'Cliente Ltda',
  nombre_carpeta: 'NCA',
  periodo: '2026-07',
  fecha_emision: '2026-07-05',
  fecha_vencimiento: '2026-07-05',
  forma_pago: 'CONTADO',
  tipo_venta: 'Del Giro',
  tipo_compra: 'Del Giro',
  valor_uf: 39418.53,
  lineas: [
    { cobro_id: 'C1', descripcion: 'A', moneda: 'UF', monto_neto_original: 33.5, cantidad: 1, precio_unitario_clp: 1320521, total_linea_clp: 1320521 },
    { cobro_id: 'C2', descripcion: 'B', moneda: 'CLP', monto_neto_original: 100, cantidad: 1, precio_unitario_clp: 100, total_linea_clp: 100 },
  ],
  neto_clp: 1320621,
  iva_clp: 250918,
  total_clp: 1571539,
  remitente: 'f@e.cl',
  destinatarios: ['a@b.cl'],
  copia: ['c@e.cl'],
};

describe('filaExcelDesdePayload', () => {
  it('une los cobro_id con punto y coma y formatea montos', () => {
    const fila = filaExcelDesdePayload(payload, 'BORRADOR');
    expect(fila.cobro_id).toBe('C1;C2');
    expect(fila.valor_uf).toBe('39418.53');
    expect(fila.monto_neto_clp).toBe('1320621');
    expect(fila.estado).toBe('BORRADOR');
    expect(fila.folio_sii).toBe('');
  });
});

describe('FacturasRepository.reconciliar', () => {
  function crear(filasExcel: Record<string, string>[]) {
    const store = new AuditStore(':memory:');
    const excel = {
      leerTabla: vi.fn().mockResolvedValue(filasExcel),
      agregarFilaFacturas: vi.fn(),
      actualizarFilaFacturas: vi.fn(),
    } as unknown as ExcelAdapter;
    return { store, excel, repo: new FacturasRepository(store, excel) };
  }

  it('pasa cuando Excel y SQLite son consistentes', async () => {
    const { store, repo } = crear([
      { factura_id: payload.factura_id, folio_sii: '', estado: 'BORRADOR' },
    ]);
    store.crearFactura(payload, 'h');
    await expect(repo.reconciliar()).resolves.toBeUndefined();
  });

  it('detiene el proceso si Excel tiene folio y SQLite no registra emisión', async () => {
    const { store, repo } = crear([
      { factura_id: payload.factura_id, folio_sii: '999', estado: 'EMITIDA' },
    ]);
    store.crearFactura(payload, 'h'); // queda en BORRADOR, sin folio
    await expect(repo.reconciliar()).rejects.toThrow(/contradicci[oó]n/i);
  });

  it('detiene el proceso si SQLite tiene folio y la fila no está en Excel', async () => {
    const { store, repo } = crear([]);
    store.crearFactura(payload, 'h');
    store.registrarTransicion(payload.factura_id, 'PENDIENTE_APROBACION', 't');
    store.registrarTransicion(payload.factura_id, 'APROBADA', 't');
    store.registrarTransicion(payload.factura_id, 'EMITIENDO', 't');
    store.registrarTransicion(payload.factura_id, 'EMITIDA', 't');
    store.guardarFolio(payload.factura_id, '777');
    await expect(repo.reconciliar()).rejects.toThrow(/contradicci[oó]n/i);
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `pnpm vitest run tests/store/facturas-repository.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 3: Implementación mínima**

```ts
// src/store/facturas-repository.ts
import type { ExcelAdapter, FilaFacturasExcel } from '../adapters/excel/excel-adapter.js';
import type { Estado, InvoicePayload } from '../domain/tipos.js';
import type { AuditStore } from './audit-store.js';

export function filaExcelDesdePayload(payload: InvoicePayload, estado: Estado): FilaFacturasExcel {
  return {
    factura_id: payload.factura_id,
    cobro_id: payload.lineas.map((l) => l.cobro_id).join(';'),
    periodo: payload.periodo,
    fecha_emision: payload.fecha_emision,
    valor_uf: payload.valor_uf === null ? '' : String(payload.valor_uf),
    monto_neto_clp: String(payload.neto_clp),
    iva_clp: String(payload.iva_clp),
    total_clp: String(payload.total_clp),
    folio_sii: '',
    estado,
    pdf_path: '',
    aprobada_por: '',
    fecha_aprobacion: '',
    fecha_envio: '',
    error: '',
  };
}

export class FacturasRepository {
  constructor(
    private readonly store: AuditStore,
    private readonly excel: ExcelAdapter,
  ) {}

  async registrarBorrador(payload: InvoicePayload): Promise<void> {
    await this.excel.agregarFilaFacturas(filaExcelDesdePayload(payload, 'BORRADOR'));
  }

  async reflejar(facturaId: string, cambios: Partial<FilaFacturasExcel>): Promise<void> {
    await this.excel.actualizarFilaFacturas(facturaId, cambios);
  }

  async reconciliar(): Promise<void> {
    const filas = await this.excel.leerTabla('tblFacturas');
    const porId = new Map(filas.map((f) => [f.factura_id as string, f]));

    for (const [facturaId, fila] of porId) {
      const local = this.store.obtenerFactura(facturaId);
      const folioExcel = (fila.folio_sii ?? '').trim();
      if (folioExcel && (!local || !local.folio_sii)) {
        throw new Error(
          `Contradicción: ${facturaId} tiene folio ${folioExcel} en Excel pero SQLite no registra emisión. Revisión manual requerida.`,
        );
      }
      if (folioExcel && local?.folio_sii && folioExcel !== local.folio_sii) {
        throw new Error(
          `Contradicción: ${facturaId} folio Excel=${folioExcel} difiere de SQLite=${local.folio_sii}. Revisión manual requerida.`,
        );
      }
    }

    for (const facturaId of this.store.listarFacturaIds()) {
      const local = this.store.obtenerFactura(facturaId);
      if (local?.folio_sii && !porId.has(facturaId)) {
        throw new Error(
          `Contradicción: ${facturaId} está EMITIDA en SQLite (folio ${local.folio_sii}) pero no existe en tblFacturas. Revisión manual requerida.`,
        );
      }
    }
  }
}
```

Añadir a `AuditStore` (mismo commit):

```ts
// src/store/audit-store.ts — método adicional
  listarFacturaIds(): string[] {
    return (this.db.prepare('SELECT factura_id FROM invoice_runs ORDER BY factura_id').all() as { factura_id: string }[])
      .map((f) => f.factura_id);
  }
```

- [ ] **Step 4: Verificar que pasa**

Run: `pnpm vitest run tests/store/facturas-repository.test.ts && pnpm test`
Expected: PASS; suite completa en verde.

- [ ] **Step 5: Commit**

```bash
git add src/store/facturas-repository.ts src/store/audit-store.ts tests/store/facturas-repository.test.ts
git commit -m "feat: espejo tblFacturas y reconciliación Excel-SQLite"
```

---

### Task 17: Configuración, keychain, logger y preflight

**Files:**
- Create: `src/config/config.ts`, `src/config/keychain.ts`, `src/services/logger.ts`, `src/config/preflight.ts`
- Test: `tests/config/config.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// tests/config/config.test.ts
import { describe, expect, it } from 'vitest';
import { esquemaConfig } from '../../src/config/config.js';

const configOk = {
  tenantId: 'tenant-guid',
  clientId: 'client-guid',
  buzonPrincipal: 'buzon@empresa.cl',
  driveId: 'D1',
  itemId: 'I1',
  rutaRaizClientes: '/Users/andrespsijas/Documents/Codex/agente factura sii/cliente',
  rutaDatos: '.data',
  timeoutSiiMs: 120000,
  timeoutAprobacionMs: 300000,
  modoPredeterminado: 'simulation',
  emisores: {
    E1: { tipoVenta: 'Del Giro', tipoCompra: 'Del Giro' },
  },
};

describe('esquemaConfig', () => {
  it('acepta una configuración completa', () => {
    expect(esquemaConfig.parse(configOk).modoPredeterminado).toBe('simulation');
  });
  it('el modo predeterminado solo puede ser simulation', () => {
    expect(() => esquemaConfig.parse({ ...configOk, modoPredeterminado: 'emit' })).toThrow();
  });
  it('exige tipoVenta y tipoCompra por emisor (sin valores por defecto)', () => {
    expect(() => esquemaConfig.parse({ ...configOk, emisores: { E1: { tipoVenta: 'Del Giro' } } })).toThrow();
    expect(() => esquemaConfig.parse({ ...configOk, emisores: {} })).toThrow(/emisor/i);
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `pnpm vitest run tests/config/config.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 3: Implementar config.ts**

```ts
// src/config/config.ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const esquemaConfig = z.object({
  tenantId: z.string().min(1),
  clientId: z.string().min(1),
  buzonPrincipal: z.string().email(),
  driveId: z.string().min(1),
  itemId: z.string().min(1),
  rutaRaizClientes: z.string().min(1),
  rutaDatos: z.string().min(1).default('.data'),
  timeoutSiiMs: z.number().int().positive().default(120000),
  timeoutAprobacionMs: z.number().int().positive().default(300000),
  modoPredeterminado: z.literal('simulation'),
  emisores: z
    .record(z.object({ tipoVenta: z.string().min(1), tipoCompra: z.string().min(1) }))
    .refine((e) => Object.keys(e).length > 0, 'Debe configurarse al menos un emisor'),
});

export type Config = z.output<typeof esquemaConfig>;

export async function cargarConfig(raizProyecto: string): Promise<Config> {
  const ruta = join(raizProyecto, '.data', 'config.json');
  let crudo: string;
  try {
    crudo = await readFile(ruta, 'utf8');
  } catch {
    throw new Error(`No existe ${ruta}. Ejecute: pnpm agent -- setup`);
  }
  return esquemaConfig.parse(JSON.parse(crudo));
}
```

- [ ] **Step 4: Implementar keychain.ts y logger.ts (sin test unitario: envuelven binarios del sistema; el preflight los verifica en runtime)**

```ts
// src/config/keychain.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const ejecutar = promisify(execFile);
const SERVICIO = 'agente-factura-sii';

// La credencial se guarda una vez con:
//   security add-generic-password -s agente-factura-sii -a <rut_emisor> -w
// (el flag -w sin valor pide la contraseña de forma interactiva, sin dejarla en el historial)
export async function leerSecretoKeychain(cuenta: string): Promise<string> {
  try {
    const { stdout } = await ejecutar('security', [
      'find-generic-password', '-s', SERVICIO, '-a', cuenta, '-w',
    ]);
    const secreto = stdout.replace(/\n$/, '');
    if (!secreto) throw new Error('vacío');
    return secreto;
  } catch {
    throw new Error(
      `No hay secreto en el llavero para servicio=${SERVICIO} cuenta=${cuenta}. ` +
        `Guárdelo con: security add-generic-password -s ${SERVICIO} -a ${cuenta} -w`,
    );
  }
}
```

```ts
// src/services/logger.ts
import pino from 'pino';

const RE_RUT = /\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b/g;
const RE_CORREO = /[^\s@;"']+@[^\s@;"']+\.[^\s@;"']+/g;
const RE_TOKEN = /\b(eyJ[\w-]+\.[\w-]+\.[\w-]+|Bearer\s+\S+)\b/g;

export function redactarTexto(texto: string): string {
  return texto
    .replace(RE_TOKEN, '[TOKEN]')
    .replace(RE_RUT, (m) => `${m.slice(0, 2)}***-*`)
    .replace(RE_CORREO, (m) => `${m.slice(0, 2)}***@***`);
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  hooks: {
    logMethod(args, metodo) {
      const saneados = args.map((a) => (typeof a === 'string' ? redactarTexto(a) : a));
      metodo.apply(this, saneados as Parameters<typeof metodo>);
    },
  },
  redact: { paths: ['password', 'token', 'authorization', 'cookie', '*.password', '*.token'], censor: '[REDACTADO]' },
});
```

- [ ] **Step 5: Implementar preflight.ts**

```ts
// src/config/preflight.ts
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { IGraphClient } from '../adapters/graph/graph-client.js';
import { leerSecretoKeychain } from './keychain.js';

export interface ResultadoPreflight {
  ok: boolean;
  fallas: string[];
}

export async function preflight(
  config: Config,
  graph: IGraphClient,
  rutEmisor: string,
  opciones: { verificarGraph: boolean },
): Promise<ResultadoPreflight> {
  const fallas: string[] = [];

  await mkdir(join(config.rutaDatos, 'evidence'), { recursive: true });
  try {
    await access(config.rutaRaizClientes);
  } catch {
    fallas.push(`Ruta raíz de clientes inaccesible: ${config.rutaRaizClientes}`);
  }

  try {
    await leerSecretoKeychain(rutEmisor);
  } catch (e) {
    fallas.push((e as Error).message);
  }

  if (opciones.verificarGraph) {
    try {
      await graph.solicitar('GET', '/me');
    } catch (e) {
      fallas.push(`Graph no autenticado o sin permisos: ${(e as Error).message}`);
    }
    try {
      await graph.solicitar('GET', `/drives/${config.driveId}/items/${config.itemId}`);
    } catch (e) {
      fallas.push(`Libro de OneDrive inaccesible: ${(e as Error).message}`);
    }
  }

  return { ok: fallas.length === 0, fallas };
}
```

Nota: la verificación de que Exchange permite "enviar como" el alias no tiene API pública fiable; el diseño la cubre con la prueba de correo `[PRUEBA]` de la validación controlada (§11.3). El preflight verifica token, permisos y acceso al libro; el primer envío real de prueba valida el alias.

- [ ] **Step 6: Verificar que pasa**

Run: `pnpm vitest run tests/config/config.test.ts && pnpm typecheck`
Expected: PASS (3 tests) y typecheck limpio.

- [ ] **Step 7: Commit**

```bash
git add src/config tests/config/config.test.ts src/services/logger.ts
git commit -m "feat: configuración validada, keychain, logger con redacción y preflight"
```

---

### Task 18: InvoiceEngine — construcción del payload completo

**Files:**
- Create: `src/domain/motor.ts`
- Test: `tests/domain/motor.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
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
```

- [ ] **Step 2: Verificar que falla**

Run: `pnpm vitest run tests/domain/motor.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 3: Implementación mínima**

```ts
// src/domain/motor.ts
import type { GrupoFacturable } from './agrupacion.js';
import { lineaClp, lineaUf, totalesEsperados } from './dinero.js';
import { fechaVencimiento } from './fechas.js';
import type { Cliente, Empresa, InvoicePayload, LineaFactura } from './tipos.js';
import { parsearDestinatarios } from './validacion.js';

export interface ClasificacionEmisor {
  tipoVenta: string;
  tipoCompra: string;
}

export function construirPayload(
  grupo: GrupoFacturable,
  empresa: Empresa,
  cliente: Cliente,
  clasificacion: ClasificacionEmisor,
  valorUf: number | null,
): InvoicePayload {
  const formasPago = new Set(grupo.cobros.map((c) => c.forma_pago));
  if (formasPago.size > 1) {
    throw new Error(`forma_pago inconsistente en el grupo ${grupo.clave}: ${[...formasPago].join(', ')}`);
  }
  const diasVencimiento = new Set(grupo.cobros.map((c) => c.dias_vencimiento));
  if (diasVencimiento.size > 1) {
    throw new Error(`dias_vencimiento inconsistente en el grupo ${grupo.clave}`);
  }
  const requiereUf = grupo.cobros.some((c) => c.moneda === 'UF');
  if (requiereUf && valorUf === null) {
    throw new Error(`El grupo ${grupo.clave} tiene líneas UF y no hay valor UF; factura bloqueada`);
  }

  const lineas: LineaFactura[] = grupo.cobros.map((c) => {
    const calculo =
      c.moneda === 'CLP'
        ? lineaClp(c.monto_neto, c.cantidad)
        : lineaUf(c.monto_neto, c.cantidad, valorUf as number);
    return {
      cobro_id: c.cobro_id,
      descripcion: c.descripcion_servicio,
      moneda: c.moneda,
      monto_neto_original: c.monto_neto,
      cantidad: c.cantidad,
      precio_unitario_clp: calculo.precioUnitarioClp,
      total_linea_clp: calculo.totalLineaClp,
    };
  });

  const totales = totalesEsperados(lineas.map((l) => l.total_linea_clp));
  const primero = grupo.cobros[0]!;

  return {
    factura_id: grupo.clave,
    empresa_id: empresa.empresa_id,
    rut_emisor: empresa.rut_emisor,
    razon_social_emisor: empresa.razon_social,
    cliente_id: cliente.cliente_id,
    rut_cliente: cliente.rut_cliente,
    razon_social_cliente: cliente.razon_social,
    nombre_carpeta: cliente.nombre_carpeta,
    periodo: grupo.periodo,
    fecha_emision: grupo.fechaProgramada,
    fecha_vencimiento: fechaVencimiento(grupo.fechaProgramada, primero.forma_pago, primero.dias_vencimiento),
    forma_pago: primero.forma_pago,
    tipo_venta: clasificacion.tipoVenta,
    tipo_compra: clasificacion.tipoCompra,
    valor_uf: requiereUf ? valorUf : null,
    lineas,
    neto_clp: totales.netoClp,
    iva_clp: totales.ivaClp,
    total_clp: totales.totalClp,
    remitente: empresa.email_remitente,
    destinatarios: parsearDestinatarios(cliente.email_facturacion),
    copia: parsearDestinatarios(empresa.email_copia),
  };
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `pnpm vitest run tests/domain/motor.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/motor.ts tests/domain/motor.test.ts
git commit -m "feat: motor de facturas que construye el payload inmutable"
```

---

### Task 19: CLI — prepare, preview-sii, emit, retry-email, setup + lock de proceso

**Files:**
- Create: `src/cli/lock.ts`, `src/cli/comandos.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/cli/comandos.test.ts`

- [ ] **Step 1: Escribir el test de integración simulada que falla**

```ts
// tests/cli/comandos.test.ts
import { describe, expect, it, vi } from 'vitest';
import { ejecutarPrepare, ejecutarEmit } from '../../src/cli/comandos.js';
import { AuditStore } from '../../src/store/audit-store.js';
import { ENCABEZADOS } from '../../src/adapters/excel/excel-adapter.js';
import type { Dependencias } from '../../src/cli/comandos.js';

const filasEmpresas = [
  { empresa_id: 'E1', rut_emisor: '12.345.678-5', razon_social: 'Emisora SpA', email_remitente: 'f@e.cl', email_copia: 'c@e.cl', activo: 'TRUE' },
];
const filasClientes = [
  { cliente_id: 'CL1', razon_social: 'Cliente Ltda', nombre_carpeta: 'NCA', rut_cliente: '11.111.111-1', email_facturacion: 'pagos@cliente.cl', giro: 'Servicios', direccion: 'Calle 1', comuna: 'Prov', ciudad: 'Stgo', activo: 'TRUE' },
];
const filasCobros = [
  { cobro_id: 'C1', empresa_id: 'E1', cliente_id: 'CL1', descripcion_servicio: 'Asesoría', moneda: 'UF', monto_neto: '33.5', cantidad: '1', frecuencia: 'MENSUAL', dia_emision: '5', forma_pago: 'CONTADO', dias_vencimiento: '0', fecha_inicio: '2026-01-01', fecha_fin: '', activo: 'TRUE' },
];

function dependenciasSimuladas(): Dependencias {
  const store = new AuditStore(':memory:');
  const tablas: Record<string, Record<string, string>[]> = {
    tblEmpresas: filasEmpresas,
    tblClientes: filasClientes,
    tblCobrosRecurrentes: filasCobros,
    tblFacturas: [],
  };
  return {
    store,
    excel: {
      leerTabla: vi.fn(async (nombre: string) => tablas[nombre] ?? []),
      agregarFilaFacturas: vi.fn(async (fila) => { tablas.tblFacturas!.push(fila as never); }),
      actualizarFilaFacturas: vi.fn(async () => undefined),
    } as never,
    uf: { obtenerValorUf: vi.fn(async () => ({ valor: 39418.53, fecha: '2026-07-05', url: 'x', consultadoEn: 'y' })) } as never,
    sii: {
      abrirYPreparar: vi.fn(),
      extraerPreview: vi.fn(async () => ({ totales: { netoClp: 1320521, ivaClp: 250899, totalClp: 1571420 }, coinciden: true, diferencias: [] })),
      emitirUnaVez: vi.fn(async () => ({ folio: '12345', pdf: Buffer.from('%PDF-1.4\n%%EOF\n') })),
      consultarDocumentosEmitidos: vi.fn(async () => null),
      cerrar: vi.fn(),
    } as never,
    correo: { enviarFactura: vi.fn(async () => undefined) } as never,
    aprobacion: {
      solicitarAprobacion: vi.fn(async (p) => ({ aprobada: true, hash: '', actor: 'andres', fecha: '2026-07-05T10:00:00Z' })),
      hashVigente: vi.fn(() => true),
    } as never,
    clasificaciones: { E1: { tipoVenta: 'Del Giro', tipoCompra: 'Del Giro' } },
    rutaRaizClientes: '/tmp/agente-test-clientes',
    hoy: () => '2026-07-05',
  };
}

describe('ejecutarPrepare (simulación)', () => {
  it('crea la factura en PENDIENTE_APROBACION sin tocar SII ni correo', async () => {
    const deps = dependenciasSimuladas();
    const resultado = await ejecutarPrepare(deps, '2026-07-05');
    expect(resultado.preparadas).toEqual(['RECURRENT:E1:CL1:2026-07']);
    expect(deps.store.obtenerFactura('RECURRENT:E1:CL1:2026-07')?.estado).toBe('PENDIENTE_APROBACION');
    expect((deps.sii.abrirYPreparar as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((deps.correo.enviarFactura as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((deps.excel.agregarFilaFacturas as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('es idempotente: una segunda ejecución no duplica la factura', async () => {
    const deps = dependenciasSimuladas();
    await ejecutarPrepare(deps, '2026-07-05');
    const segunda = await ejecutarPrepare(deps, '2026-07-05');
    expect(segunda.preparadas).toEqual([]);
    expect(segunda.omitidas).toEqual(['RECURRENT:E1:CL1:2026-07']);
  });
});

describe('ejecutarEmit', () => {
  it('recorre el ciclo completo hasta ENVIADA con una sola emisión', async () => {
    const deps = dependenciasSimuladas();
    await ejecutarPrepare(deps, '2026-07-05');
    await ejecutarEmit(deps, 'RECURRENT:E1:CL1:2026-07');
    const f = deps.store.obtenerFactura('RECURRENT:E1:CL1:2026-07');
    expect(f?.estado).toBe('ENVIADA');
    expect(f?.folio_sii).toBe('12345');
    expect((deps.sii.emitirUnaVez as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('no emite si la vista previa del SII no coincide', async () => {
    const deps = dependenciasSimuladas();
    (deps.sii.extraerPreview as ReturnType<typeof vi.fn>).mockResolvedValue({
      totales: { netoClp: 1, ivaClp: 1, totalClp: 2 }, coinciden: false, diferencias: ['neto: esperado 1320521, SII muestra 1'],
    });
    await ejecutarPrepare(deps, '2026-07-05');
    await expect(ejecutarEmit(deps, 'RECURRENT:E1:CL1:2026-07')).rejects.toThrow(/coinciden|REVISION/i);
    expect(deps.store.obtenerFactura('RECURRENT:E1:CL1:2026-07')?.estado).toBe('REQUIERE_REVISION');
    expect((deps.sii.emitirUnaVez as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('no emite si el operador no aprueba', async () => {
    const deps = dependenciasSimuladas();
    (deps.aprobacion.solicitarAprobacion as ReturnType<typeof vi.fn>).mockResolvedValue({
      aprobada: false, hash: '', actor: 'andres', fecha: 'x',
    });
    await ejecutarPrepare(deps, '2026-07-05');
    await expect(ejecutarEmit(deps, 'RECURRENT:E1:CL1:2026-07')).rejects.toThrow(/aprobaci[oó]n/i);
    expect((deps.sii.emitirUnaVez as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `pnpm vitest run tests/cli/comandos.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 3: Implementar comandos.ts**

```ts
// src/cli/comandos.ts
import { hashPayload } from '../domain/hash.js';
import { agruparCobros } from '../domain/agrupacion.js';
import { construirPayload, type ClasificacionEmisor } from '../domain/motor.js';
import { esquemaCliente, esquemaCobro, esquemaEmpresa } from '../domain/validacion.js';
import type { InvoicePayload } from '../domain/tipos.js';
import type { ExcelAdapter } from '../adapters/excel/excel-adapter.js';
import type { UfProvider } from '../adapters/uf/uf-provider.js';
import type { ISiiAdapter } from '../adapters/sii/sii-adapter.js';
import type { MailService } from '../services/correo.js';
import type { ApprovalService } from '../services/aprobacion.js';
import { guardarPdf, rutaFactura } from '../services/storage.js';
import { filaExcelDesdePayload } from '../store/facturas-repository.js';
import type { AuditStore } from '../store/audit-store.js';
import { logger } from '../services/logger.js';

export interface Dependencias {
  store: AuditStore;
  excel: ExcelAdapter;
  uf: UfProvider;
  sii: ISiiAdapter;
  correo: MailService;
  aprobacion: ApprovalService;
  clasificaciones: Record<string, ClasificacionEmisor>;
  rutaRaizClientes: string;
  hoy: () => string;
}

export interface ResultadoPrepare {
  preparadas: string[];
  omitidas: string[];
  bloqueadas: string[];
  atrasadas: string[];
}

export async function ejecutarPrepare(deps: Dependencias, fecha?: string): Promise<ResultadoPrepare> {
  const fechaObjetivo = fecha ?? deps.hoy();
  const empresas = (await deps.excel.leerTabla('tblEmpresas')).map((f) => esquemaEmpresa.parse(f));
  const clientes = (await deps.excel.leerTabla('tblClientes')).map((f) => esquemaCliente.parse(f));
  const cobros = (await deps.excel.leerTabla('tblCobrosRecurrentes')).map((f) => esquemaCobro.parse(f));

  const { grupos, bloqueados, atrasados } = agruparCobros(cobros, fechaObjetivo, deps.hoy());
  const resultado: ResultadoPrepare = {
    preparadas: [],
    omitidas: [],
    bloqueadas: bloqueados.map((b) => `${b.empresaId}/${b.clienteId}: ${b.motivo}`),
    atrasadas: atrasados.map((a) => `${a.empresaId}/${a.clienteId}: ${a.motivo}`),
  };

  for (const grupo of grupos) {
    if (deps.store.obtenerFactura(grupo.clave)) {
      resultado.omitidas.push(grupo.clave);
      continue;
    }
    const empresa = empresas.find((e) => e.empresa_id === grupo.empresaId && e.activo);
    const cliente = clientes.find((c) => c.cliente_id === grupo.clienteId && c.activo);
    const clasificacion = deps.clasificaciones[grupo.empresaId];
    if (!empresa || !cliente || !clasificacion) {
      throw new Error(`Datos maestros incompletos para el grupo ${grupo.clave}`);
    }
    const requiereUf = grupo.cobros.some((c) => c.moneda === 'UF');
    const valorUf = requiereUf ? (await deps.uf.obtenerValorUf(grupo.fechaProgramada)).valor : null;
    const payload = construirPayload(grupo, empresa, cliente, clasificacion, valorUf);
    deps.store.crearFactura(payload, hashPayload(payload));
    deps.store.registrarTransicion(payload.factura_id, 'PENDIENTE_APROBACION', 'preparación en simulación');
    await deps.excel.agregarFilaFacturas(filaExcelDesdePayload(payload, 'PENDIENTE_APROBACION'));
    resultado.preparadas.push(payload.factura_id);
  }

  logger.info({ resultado }, 'prepare completado');
  return resultado;
}

function payloadDesdeStore(deps: Dependencias, facturaId: string): InvoicePayload {
  const fila = deps.store.obtenerFactura(facturaId);
  if (!fila) throw new Error(`Factura no encontrada: ${facturaId}`);
  return JSON.parse(fila.payload_json) as InvoicePayload;
}

export async function ejecutarPreviewSii(deps: Dependencias, facturaId: string): Promise<void> {
  const fila = deps.store.obtenerFactura(facturaId);
  if (!fila) throw new Error(`Factura no encontrada: ${facturaId}`);
  const payload = payloadDesdeStore(deps, facturaId);
  if (hashPayload(payload) !== fila.payload_hash) {
    throw new Error('El payload cambió desde la preparación; regenerar con prepare');
  }
  await deps.sii.abrirYPreparar(payload);
  const preview = await deps.sii.extraerPreview(payload);
  if (!preview.coinciden) {
    deps.store.registrarTransicion(facturaId, 'REQUIERE_REVISION', preview.diferencias.join(' | '));
    await deps.excel.actualizarFilaFacturas(facturaId, { estado: 'REQUIERE_REVISION', error: preview.diferencias.join(' | ') });
    throw new Error(`Los totales del SII no coinciden: ${preview.diferencias.join(' | ')}`);
  }
  logger.info({ facturaId, totales: preview.totales }, 'vista previa SII coincide; detenido antes de emitir');
}

export async function ejecutarEmit(deps: Dependencias, facturaId: string): Promise<void> {
  const fila = deps.store.obtenerFactura(facturaId);
  if (!fila) throw new Error(`Factura no encontrada: ${facturaId}`);
  if (fila.estado !== 'PENDIENTE_APROBACION') {
    throw new Error(`La factura está en ${fila.estado}; emit exige PENDIENTE_APROBACION`);
  }
  const payload = payloadDesdeStore(deps, facturaId);
  if (hashPayload(payload) !== fila.payload_hash) {
    throw new Error('El payload cambió desde la preparación; regenerar con prepare');
  }

  const carpeta = payload.nombre_carpeta;
  const rutaPrevista = rutaFactura(deps.rutaRaizClientes, carpeta, payload.fecha_emision, 'PENDIENTE', carpeta);

  await deps.sii.abrirYPreparar(payload);
  const preview = await deps.sii.extraerPreview(payload);
  if (!preview.coinciden) {
    deps.store.registrarTransicion(facturaId, 'REQUIERE_REVISION', preview.diferencias.join(' | '));
    await deps.excel.actualizarFilaFacturas(facturaId, { estado: 'REQUIERE_REVISION', error: preview.diferencias.join(' | ') });
    throw new Error(`Los totales del SII no coinciden; REQUIERE_REVISION: ${preview.diferencias.join(' | ')}`);
  }

  const aprobacion = await deps.aprobacion.solicitarAprobacion(payload, rutaPrevista);
  if (!aprobacion.aprobada) {
    throw new Error('Aprobación denegada o texto incorrecto; no se emite');
  }
  if (!deps.aprobacion.hashVigente(payload, fila.payload_hash)) {
    throw new Error('El hash aprobado no coincide con el payload vigente; no se emite');
  }
  deps.store.registrarAprobacion(facturaId, aprobacion.actor, fila.payload_hash, aprobacion.fecha);
  deps.store.registrarTransicion(facturaId, 'APROBADA', `aprobada por ${aprobacion.actor}`);
  deps.store.registrarTransicion(facturaId, 'EMITIENDO', 'única acción de emisión');

  let emision;
  try {
    emision = await deps.sii.emitirUnaVez();
  } catch (error) {
    // Respuesta incierta: consultar documentos emitidos antes de permitir otra acción (diseño §5 SiiAdapter).
    const folioExistente = await deps.sii.consultarDocumentosEmitidos(payload.rut_cliente, payload.fecha_emision);
    const detalle = folioExistente
      ? `emisión incierta; documentos emitidos muestra folio ${folioExistente}`
      : `emisión incierta sin folio visible: ${(error as Error).message}`;
    deps.store.registrarTransicion(facturaId, 'REQUIERE_REVISION', detalle);
    await deps.excel.actualizarFilaFacturas(facturaId, { estado: 'REQUIERE_REVISION', error: detalle });
    throw new Error(detalle);
  }

  deps.store.registrarTransicion(facturaId, 'EMITIDA', `folio ${emision.folio}`);
  deps.store.guardarFolio(facturaId, emision.folio);

  const rutaFinal = rutaFactura(deps.rutaRaizClientes, carpeta, payload.fecha_emision, emision.folio, carpeta);
  try {
    await guardarPdf(rutaFinal, emision.pdf);
  } catch (error) {
    deps.store.registrarTransicion(facturaId, 'ERROR_REINTENTABLE', `PDF: ${(error as Error).message}`);
    await deps.excel.actualizarFilaFacturas(facturaId, { estado: 'ERROR_REINTENTABLE', folio_sii: emision.folio, error: (error as Error).message });
    throw error;
  }
  deps.store.guardarRutaPdf(facturaId, rutaFinal);
  deps.store.registrarTransicion(facturaId, 'DESCARGADA', rutaFinal);

  try {
    await deps.correo.enviarFactura({
      remitente: payload.remitente,
      destinatarios: payload.destinatarios,
      copia: payload.copia,
      asunto: `Factura ${emision.folio} — ${payload.razon_social_emisor} — ${payload.periodo}`,
      cuerpo: `Estimados,\n\nAdjuntamos la factura electrónica N° ${emision.folio} correspondiente al período ${payload.periodo}.\n\nSaludos,\n${payload.razon_social_emisor}`,
      rutaPdf: rutaFinal,
    });
    deps.store.registrarIntentoCorreo(facturaId, true, 'enviado');
  } catch (error) {
    deps.store.registrarIntentoCorreo(facturaId, false, (error as Error).message);
    deps.store.registrarTransicion(facturaId, 'ERROR_REINTENTABLE', `correo: ${(error as Error).message}`);
    await deps.excel.actualizarFilaFacturas(facturaId, {
      estado: 'ERROR_REINTENTABLE', folio_sii: emision.folio, pdf_path: rutaFinal, error: (error as Error).message,
    });
    throw error;
  }
  deps.store.registrarTransicion(facturaId, 'ENVIADA', 'correo enviado');
  await deps.excel.actualizarFilaFacturas(facturaId, {
    estado: 'ENVIADA', folio_sii: emision.folio, pdf_path: rutaFinal,
    aprobada_por: aprobacion.actor, fecha_aprobacion: aprobacion.fecha,
    fecha_envio: new Date().toISOString(), error: '',
  });
}

export async function ejecutarRetryEmail(deps: Dependencias, facturaId: string): Promise<void> {
  const fila = deps.store.obtenerFactura(facturaId);
  if (!fila) throw new Error(`Factura no encontrada: ${facturaId}`);
  if (!fila.folio_sii || !fila.pdf_path) {
    throw new Error('retry-email exige folio y PDF verificado; no invoca SiiAdapter');
  }
  if (fila.estado !== 'ERROR_REINTENTABLE' && fila.estado !== 'DESCARGADA') {
    throw new Error(`retry-email no aplica en estado ${fila.estado}`);
  }
  const payload = payloadDesdeStore(deps, facturaId);
  try {
    await deps.correo.enviarFactura({
      remitente: payload.remitente,
      destinatarios: payload.destinatarios,
      copia: payload.copia,
      asunto: `Factura ${fila.folio_sii} — ${payload.razon_social_emisor} — ${payload.periodo}`,
      cuerpo: `Estimados,\n\nAdjuntamos la factura electrónica N° ${fila.folio_sii} correspondiente al período ${payload.periodo}.\n\nSaludos,\n${payload.razon_social_emisor}`,
      rutaPdf: fila.pdf_path,
    });
    deps.store.registrarIntentoCorreo(facturaId, true, 'reintento exitoso');
    deps.store.registrarTransicion(facturaId, 'ENVIADA', 'correo enviado en reintento');
    await deps.excel.actualizarFilaFacturas(facturaId, { estado: 'ENVIADA', fecha_envio: new Date().toISOString(), error: '' });
  } catch (error) {
    deps.store.registrarIntentoCorreo(facturaId, false, (error as Error).message);
    throw error;
  }
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `pnpm vitest run tests/cli/comandos.test.ts`
Expected: PASS (6 tests). Nota: en el test de emit tras `ejecutarPrepare` el estado es `PENDIENTE_APROBACION`, como exige `ejecutarEmit`.

- [ ] **Step 5: Implementar lock.ts y el wiring de index.ts**

```ts
// src/cli/lock.ts
import lockfile from 'proper-lockfile';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export async function conBloqueo<T>(rutaDatos: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(rutaDatos, { recursive: true });
  const objetivo = join(rutaDatos, 'agente.lock');
  if (!existsSync(objetivo)) writeFileSync(objetivo, '');
  let liberar: (() => Promise<void>) | null = null;
  try {
    liberar = await lockfile.lock(objetivo, { stale: 15 * 60 * 1000 });
  } catch {
    throw new Error('Otra ejecución del agente está activa; solo un flujo SII puede correr a la vez');
  }
  try {
    return await fn();
  } finally {
    await liberar?.();
  }
}
```

```ts
// src/cli/index.ts (reemplazo completo)
import { Command } from 'commander';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { userInfo } from 'node:os';
import { cargarConfig } from '../config/config.js';
import { preflight } from '../config/preflight.js';
import { crearAutenticadorDeviceCode, GraphClient } from '../adapters/graph/graph-client.js';
import { ExcelAdapter } from '../adapters/excel/excel-adapter.js';
import { UfProvider } from '../adapters/uf/uf-provider.js';
import { SiiAdapterPlaywright } from '../adapters/sii/sii-adapter.js';
import { MailService } from '../services/correo.js';
import { ApprovalService } from '../services/aprobacion.js';
import { AuditStore } from '../store/audit-store.js';
import { FacturasRepository } from '../store/facturas-repository.js';
import { conBloqueo } from './lock.js';
import {
  ejecutarEmit, ejecutarPrepare, ejecutarPreviewSii, ejecutarRetryEmail, type Dependencias,
} from './comandos.js';
import { logger } from '../services/logger.js';

const RAIZ = process.cwd();

async function armarDependencias(): Promise<{ deps: Dependencias; repo: FacturasRepository; rutEmisor: string; graph: GraphClient; rutaDatos: string }> {
  const config = await cargarConfig(RAIZ);
  const rutaDatos = join(RAIZ, config.rutaDatos);
  const graph = new GraphClient(crearAutenticadorDeviceCode(config));
  const excel = new ExcelAdapter(graph, config);
  const store = new AuditStore(join(rutaDatos, 'agente.sqlite'));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const io = {
    pregunta: (mensaje: string) =>
      Promise.race([
        rl.question(mensaje),
        new Promise<string>((_, rechazar) =>
          setTimeout(() => rechazar(new Error('Aprobación expirada')), config.timeoutAprobacionMs),
        ),
      ]),
  };
  const deps: Dependencias = {
    store,
    excel,
    uf: new UfProvider(),
    sii: new SiiAdapterPlaywright({ dirEvidencia: join(rutaDatos, 'evidence'), timeoutMs: config.timeoutSiiMs }),
    correo: new MailService(graph, config.buzonPrincipal),
    aprobacion: new ApprovalService(io, () => new Date(), userInfo().username),
    clasificaciones: config.emisores,
    rutaRaizClientes: config.rutaRaizClientes,
    hoy: () => new Date().toISOString().slice(0, 10),
  };
  const primerEmisor = Object.keys(config.emisores)[0] as string;
  return { deps, repo: new FacturasRepository(store, excel), rutEmisor: primerEmisor, graph, rutaDatos };
}

async function conEntorno(verificarGraph: boolean, fn: (deps: Dependencias, repo: FacturasRepository) => Promise<void>): Promise<void> {
  const config = await cargarConfig(RAIZ);
  const { deps, repo, rutEmisor, graph, rutaDatos } = await armarDependencias();
  await conBloqueo(rutaDatos, async () => {
    const chequeo = await preflight(config, graph, rutEmisor, { verificarGraph });
    if (!chequeo.ok) {
      throw new Error(`Preflight falló:\n- ${chequeo.fallas.join('\n- ')}`);
    }
    await repo.reconciliar();
    try {
      await fn(deps, repo);
    } finally {
      await deps.sii.cerrar();
      deps.store.cerrar();
    }
  });
}

const programa = new Command('agente-factura-sii');
programa.description('Agente local de facturación SII (modo predeterminado: simulacion)');

programa
  .command('prepare')
  .option('--mode <modo>', 'simulation (único modo de prepare)', 'simulation')
  .option('--date <fecha>', 'fecha AAAA-MM-DD (por defecto: hoy)')
  .action(async (opciones: { mode: string; date?: string }) => {
    if (opciones.mode !== 'simulation') throw new Error('prepare solo admite --mode simulation');
    await conEntorno(true, async (deps) => {
      const r = await ejecutarPrepare(deps, opciones.date);
      console.log(JSON.stringify(r, null, 2));
    });
  });

programa
  .command('preview-sii')
  .requiredOption('--invoice <factura_id>')
  .action(async (opciones: { invoice: string }) => {
    await conEntorno(true, (deps) => ejecutarPreviewSii(deps, opciones.invoice));
  });

programa
  .command('emit')
  .requiredOption('--invoice <factura_id>')
  .action(async (opciones: { invoice: string }) => {
    await conEntorno(true, (deps) => ejecutarEmit(deps, opciones.invoice));
  });

programa
  .command('retry-email')
  .requiredOption('--invoice <factura_id>')
  .action(async (opciones: { invoice: string }) => {
    await conEntorno(true, (deps) => ejecutarRetryEmail(deps, opciones.invoice));
  });

programa
  .command('setup')
  .description('Asistente interactivo: crea .data/config.json (pide el enlace del libro sin dejarlo en argumentos)')
  .action(async () => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const tenantId = await rl.question('Tenant ID de Microsoft Entra: ');
    const clientId = await rl.question('Client ID de la aplicación: ');
    const buzonPrincipal = await rl.question('Buzón principal (autenticación): ');
    const enlace = await rl.question('Pegue el enlace compartido del libro de OneDrive: ');
    const graph = new GraphClient(crearAutenticadorDeviceCode({ tenantId, clientId }));
    // Resolver driveId/itemId desde el enlace compartido (Graph shares API).
    const codificado = 'u!' + Buffer.from(enlace).toString('base64url');
    const item = await graph.solicitar<{ id: string; parentReference: { driveId: string } }>(
      'GET', `/shares/${codificado}/driveItem`,
    );
    const empresaId = await rl.question('empresa_id del emisor: ');
    const tipoVenta = await rl.question('Tipo de venta SII para este emisor: ');
    const tipoCompra = await rl.question('Tipo de compra SII para este emisor: ');
    const rutaRaizClientes = join(RAIZ, 'cliente');
    const config = {
      tenantId, clientId, buzonPrincipal,
      driveId: item.parentReference.driveId, itemId: item.id,
      rutaRaizClientes, rutaDatos: '.data',
      timeoutSiiMs: 120000, timeoutAprobacionMs: 300000,
      modoPredeterminado: 'simulation',
      emisores: { [empresaId]: { tipoVenta, tipoCompra } },
    };
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(RAIZ, '.data'), { recursive: true });
    await writeFile(join(RAIZ, '.data', 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
    console.log('Configuración guardada en .data/config.json (fuera de Git).');
    rl.close();
  });

programa.parseAsync(process.argv).catch((error: Error) => {
  logger.error(error.message);
  process.exitCode = 1;
});
```

- [ ] **Step 6: Verificar suite completa y typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: todo en verde.

- [ ] **Step 7: Commit**

```bash
git add src/cli tests/cli/comandos.test.ts
git commit -m "feat: CLI prepare/preview-sii/emit/retry-email con lock y preflight"
```

---

### Task 20: Documentación reproducible y puerta de calidad final

**Files:**
- Create: `README.md`, `docs/setup.md`

- [ ] **Step 1: Escribir README.md**

```markdown
# Agente de Facturación SII

CLI local (macOS) que prepara facturas electrónicas en el Sistema de Facturación
Gratuito del SII a partir de cobros recurrentes en un libro Excel de OneDrive,
con aprobación humana obligatoria antes de emitir.

## Comandos

| Comando | Efecto |
|---|---|
| `pnpm agent -- setup` | Asistente de configuración (crea `.data/config.json`) |
| `pnpm agent -- prepare --mode simulation [--date AAAA-MM-DD]` | Prepara facturas en simulación; no abre el SII ni envía correos |
| `pnpm agent -- preview-sii --invoice <factura_id>` | Completa la factura en el SII y compara totales; se detiene antes de emitir |
| `pnpm agent -- emit --invoice <factura_id>` | Emisión real: exige `APROBAR <factura_id>` |
| `pnpm agent -- retry-email --invoice <factura_id>` | Reintenta solo el correo; nunca vuelve a emitir |

## Calidad

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## Seguridad

- Modo predeterminado: simulación. No existen rutas implícitas hacia emisión real.
- Credencial SII en el llavero de macOS; token Graph en cache local fuera de Git.
- El agente no evade CAPTCHA ni MFA: el navegador es visible y el operador se autentica.
- Logs con redacción de RUT, correos y tokens. Evidencias en `.data/evidence`.

Ver `docs/setup.md` para la configuración inicial completa.
```

- [ ] **Step 2: Escribir docs/setup.md**

```markdown
# Configuración inicial

## 1. Aplicación Microsoft Entra

1. En https://entra.microsoft.com → App registrations → New registration.
2. Nombre: `agente-factura-sii`. Cuentas: solo este directorio.
3. En Authentication → Advanced settings → habilitar **Allow public client flows** (device code).
4. En API permissions añadir permisos *delegados* de Microsoft Graph:
   `User.Read`, `Files.ReadWrite`, `Mail.Send`, `offline_access`. Conceder consentimiento.
5. Anotar **Tenant ID** y **Client ID** para `pnpm agent -- setup`.

## 2. Credencial SII en el llavero

```bash
security add-generic-password -s agente-factura-sii -a <empresa_id> -w
```

Ingresar la clave tributaria cuando la pida (no queda en el historial).
Rotar la contraseña compartida durante el levantamiento ANTES de cualquier prueba real.

## 3. Certificado digital

Instalar el certificado digital del emisor en el llavero de macOS e importarlo en el
navegador que abre Playwright la primera vez que el SII lo solicite.

## 4. Libro de OneDrive

El libro debe contener las tablas `tblEmpresas`, `tblClientes`,
`tblCobrosRecurrentes` y `tblFacturas` con los encabezados exactos del diseño.
`pnpm agent -- setup` pide el enlace compartido de forma interactiva y lo resuelve
a `driveId`/`itemId` sin dejarlo en argumentos ni en Git.

## 5. Alias de correo

El buzón principal debe tener el alias (`email_remitente` de `tblEmpresas`)
habilitado para "Send from alias" en Exchange Online
(`Set-OrganizationConfig -SendFromAliasEnabled $true`). La validación práctica
del alias se hace con la prueba de correo `[PRUEBA]` (paso 3 de la validación
controlada); si el alias es reescrito, la factura queda en `DESCARGADA`.

## 6. Primera ejecución

```bash
pnpm install
pnpm exec playwright install chromium
pnpm agent -- setup
pnpm agent -- prepare --mode simulation --date 2026-07-05
```

## 7. Validación controlada (una sola vez)

1. `prepare` en simulación con datos reales del libro.
2. `preview-sii` real sin emitir; verificar y ajustar `src/adapters/sii/selectores.ts`
   y el parser UF contra las páginas reales.
3. Prueba de correo redirigida al buzón principal con asunto `[PRUEBA]`.
4. Una única emisión real con `emit`, seleccionada y aprobada por el usuario.
5. Revisar folio, PDF en `cliente/<carpeta>/<AAAA>/<MM>/`, correo, SQLite y Excel.
```

- [ ] **Step 3: Puerta de calidad final**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: todo en verde, cobertura ≥ 80% en el dominio.

- [ ] **Step 4: Commit final**

```bash
git add README.md docs/setup.md
git commit -m "docs: README y guía reproducible de configuración"
```

---

## Orden de ejecución recomendado

0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → **11** → 10 → 12 → 13 → 14 → 15 → 16 → 17 → 18 → 19 → 20

(La Task 11 va antes que la 10 porque `UfProvider` importa `conReintentos`.)

## Mapa spec → tasks

| Sección del diseño | Task(s) |
|---|---|
| §4 Tablas y validación | 4, 12 |
| §5 ExcelAdapter | 12 |
| §5 InvoiceEngine | 3, 5, 18 |
| §5 UfProvider | 10 |
| §5 SiiAdapter | 15 |
| §5 ApprovalService | 13 |
| §5 StorageService | 9 |
| §5 MailService | 14 |
| §5 AuditStore | 8 |
| §5 FacturasRepository | 16 |
| §6 Cálculos | 2, 18 |
| §7 Flujo operativo (4 comandos) | 19 |
| §8 Máquina de estados | 7, 8 |
| §9 Autenticación y configuración | 11, 17, 19 (setup) |
| §10 Manejo de errores (reintentos, lock, redacción) | 11, 17, 19 |
| §11 Pruebas | tests en cada task |
| §12.15 Documentación | 20 |











