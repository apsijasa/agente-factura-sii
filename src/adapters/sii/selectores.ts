// src/adapters/sii/selectores.ts
// Localizadores centralizados del Sistema de Facturación Gratuito del SII.
// Regla: roles y texto visible estable antes que selectores CSS frágiles.
// Verificar y ajustar en la primera sesión real de `preview-sii`.
export const SELECTORES = {
  urlPortal: 'https://www.sii.cl/servicios_online/1039-.html',
  // OPCION=33 = factura electrónica (DTE 33); verificado con el operador 2026-07-20.
  urlEmisionFactura: 'https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi?DESDE_DONDE_URL=OPCION%3D33%26TIPO%3D4',
  // Formulario directo (sesión autenticada y empresa ya seleccionada).
  urlFormularioFactura: 'https://www1.sii.cl/cgi-bin/Portal001/mipeGenFacEx.cgi?PTDC_CODIGO=33',
  selectorEmpresa: { rol: 'combobox', nombre: /empresa/i },
  // Formulario mipeGenFacEx.cgi — calibrado contra el portal real (2026-07-20)
  // a partir de la evidencia guardada en .data/evidence. El RUT receptor va
  // separado en cuerpo y DV; las líneas de detalle usan sufijo _01, _02, …
  campoRutReceptor: { id: '#EFXP_RUT_RECEP', etiqueta: /rut/i },
  campoDvReceptor: { id: '#EFXP_DV_RECEP' },
  campoRazonSocialReceptor: 'input[name="EFXP_RZN_SOC_RECEP"]',
  campoGiroReceptor: '[name="EFXP_GIRO_RECEP"]',
  campoDireccionReceptor: '[name="EFXP_DIR_RECEP"]',
  campoComunaReceptor: 'input[name="EFXP_CMNA_RECEP"]',
  campoCiudadReceptor: 'input[name="EFXP_CIUDAD_RECEP"]',
  campoFechaEmision: 'input[name="EFXP_FCH_EMIS"]',
  campoCiudadOrigen: 'input[name="EFXP_CIUDAD_ORIGEN"]',
  campoComunaOrigen: 'input[name="EFXP_CMNA_ORIGEN"]',
  tipoVenta: 'select[name="EFXP_TIPOVENTA_SELECT"]',
  tipoCompra: 'select[name="EFXP_TIPOCOMPRA_SELECT"]',
  formaPago: 'select[name="EFXP_FMA_PAGO"]',
  formaPagoEtiquetas: { CONTADO: 'Contado', CREDITO: 'Crédito' } as Record<string, string>,
  lineaNombre: (fila: number) => `input[name="EFXP_NMB_${String(fila + 1).padStart(2, '0')}"]`,
  lineaCantidad: (fila: number) => `input[name="EFXP_QTY_${String(fila + 1).padStart(2, '0')}"]`,
  lineaPrecio: (fila: number) => `input[name="EFXP_PRC_${String(fila + 1).padStart(2, '0')}"]`,
  botonAgregarLinea: 'input[name="AGREGA_DETALLE"]',
  botonVistaPrevia: 'button[name="Button_Update"]',
  previewNeto: { texto: /monto neto/i },
  previewIva: { texto: /iva/i },
  previewTotal: { texto: /total/i },
  botonEmitir: { rol: 'button', nombre: /firmar y enviar|emitir/i },
  folioEnConfirmacion: /folio\s*n?[°º]?\s*(\d+)/i,
  enlacePdf: { rol: 'link', nombre: /ver documento|pdf/i },
  urlDocumentosEmitidos: 'https://www1.sii.cl/cgi-bin/Portal001/mipeDocsEmit.cgi',
} as const;
