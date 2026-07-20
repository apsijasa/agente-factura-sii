// src/adapters/sii/selectores.ts
// Localizadores centralizados del Sistema de Facturación Gratuito del SII.
// Regla: roles y texto visible estable antes que selectores CSS frágiles.
// Verificar y ajustar en la primera sesión real de `preview-sii`.
export const SELECTORES = {
  urlPortal: 'https://www.sii.cl/servicios_online/1039-.html',
  urlEmisionFactura: 'https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi?DESDE_DONDE_URL=OPCION%3D2%26TIPO%3D4',
  selectorEmpresa: { rol: 'combobox', nombre: /empresa/i },
  // Formulario mipeGenFacEx.cgi (calibrado contra el portal real 2026-07-20):
  // los campos usan ids EFXP_*. El RUT receptor va separado en cuerpo y DV.
  campoRutReceptor: { id: '#EFXP_RUT_RECEP', etiqueta: /rut/i },
  campoDvReceptor: { id: '#EFXP_DV_RECEP' },
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
