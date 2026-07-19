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
