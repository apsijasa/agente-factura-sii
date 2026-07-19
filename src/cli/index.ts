import { Command } from 'commander';

const programa = new Command('agente-factura-sii');
programa.description('Agente local de facturación SII (modo predeterminado: simulacion)');
programa.parse(process.argv);
