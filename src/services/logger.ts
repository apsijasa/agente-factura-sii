// src/services/logger.ts
import pino from 'pino';

const RE_RUT = /\b\d{1,3}(?:\.?\d{3}){1,2}-[\dkK]\b/g;
const RE_CORREO = /[^\s@;"']+@[^\s@;"']+\.[^\s@;"']+/g;
const RE_TOKEN = /\b(eyJ[\w-]+\.[\w-]+\.[\w-]+|Bearer\s+\S+)\b/g;

const PROFUNDIDAD_MAXIMA = 6;

export function redactarTexto(texto: string): string {
  return texto
    .replace(RE_TOKEN, '[TOKEN]')
    .replace(RE_RUT, (m) => `${m.slice(0, 2)}***-*`)
    .replace(RE_CORREO, (m) => `${m.slice(0, 2)}***@***`);
}

export function redactarValor(
  valor: unknown,
  profundidad = 0,
  vistos = new WeakSet<object>(),
): unknown {
  if (typeof valor === 'string') return redactarTexto(valor);
  if (valor === null || typeof valor !== 'object') return valor;
  if (vistos.has(valor)) return '[CIRCULAR]';
  if (profundidad >= PROFUNDIDAD_MAXIMA) return valor;
  vistos.add(valor);
  // Caso especial: las instancias de Error no son objetos planos, así que la
  // rama de "prototipo distinto" de abajo las dejaría pasar intactas —
  // filtrando RUTs, correos o tokens que hayan quedado en message/stack.
  if (valor instanceof Error) {
    return {
      name: valor.name,
      message: redactarTexto(valor.message),
      stack: valor.stack ? redactarTexto(valor.stack) : undefined,
    };
  }
  if (Array.isArray(valor)) {
    return valor.map((v) => redactarValor(v, profundidad + 1, vistos));
  }
  const prototipo = Object.getPrototypeOf(valor);
  if (prototipo !== Object.prototype && prototipo !== null) return valor;
  const salida: Record<string, unknown> = {};
  for (const [clave, v] of Object.entries(valor)) {
    salida[clave] = redactarValor(v, profundidad + 1, vistos);
  }
  return salida;
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  hooks: {
    logMethod(args, metodo) {
      const saneados = args.map((a) => redactarValor(a));
      metodo.apply(this, saneados as Parameters<typeof metodo>);
    },
  },
  redact: {
    paths: [
      'password', 'token', 'authorization', 'cookie', '*.password', '*.token',
      'rut_emisor', 'rut_cliente', 'email_remitente', 'email_copia', 'email_facturacion',
      'destinatarios', 'copia', 'remitente', '*.rut_emisor', '*.rut_cliente',
    ],
    censor: '[REDACTADO]',
  },
});
