import { RECHARGE, SCHEDULE_REFUSALS } from "@caja/core";

/**
 * Textos de los banners de ?ok= / ?error= de /admin (los mismos de antes de 08/11, más los de los
 * interruptores nuevos). Cada sección los lee de aquí.
 */
export const OK: Record<string, string> = {
  pago_aprobado: "Pago aprobado. El negocio quedó activo con la nueva fecha.",
  pago_rechazado: "Pago rechazado.",
  pago_registrado: "Pago registrado. Queda por verificar.",
  eliminado: "Negocio borrado para siempre con todos sus datos.",
  papelera: "Negocio en la papelera: se borra solo en 15 días.",
  recuperado: "Negocio recuperado de la papelera.",
  lanzamiento: "Modo de lanzamiento guardado. Rocco lo usa desde el próximo mensaje.",
  habito: "Interruptor del hábito guardado. Rocco lo usa desde el próximo mensaje.",
  rescate: "Interruptor del registro guardado.",
  puntos: "Puntos y regalos guardados. Rocco los usa desde el próximo mensaje.",
  mes_aprobado: "Mes de regalo aprobado.",
  mes_rechazado: "Mes de regalo rechazado. Quien invitó lo verá en su próxima respuesta.",
  lote_programado:
    "Lote programado. «Plantilla (lote)» quedó encendido; el worker lo corre solo a la hora.",
  lote_cancelado: "Lote cancelado. «Plantilla (lote)» quedó apagado.",
  registro: "Listo.",
  devuelto: "Pago marcado como devuelto. La vigencia no cambió: ajústala a mano si hace falta.",
  codigo: "Código actualizado.",
  guardado: "Cambio guardado.",
  recarga: `Regalados +${RECHARGE.messages} mensajes: en la prueba suben su tope; en un plan pagado valen este mes.`,
};

/** Errores de las secciones y de la ficha del negocio. `motivo` solo si es uno conocido (LB-4). */
export function errorText(code: string | undefined, motivo?: string): string | null {
  if (!code) return null;
  const known: Record<string, string> = {
    avisos_primero:
      "Recordatorios y el aviso de las 8 pm necesitan Avisos encendido: enciéndelos juntos.",
    aviso_primero: "«8 pm para todos» necesita el aviso de las 8 pm encendido.",
    puntos_primero: "Premios e Invitaciones necesitan Puntos encendido.",
    depende: "Ese interruptor necesita otro encendido antes. Revisa el 🔒.",
    avisos_fijo: "«Avisos: apagar y encender» no se apaga una vez encendido.",
    bloqueado: "Ese interruptor no está aprobado: queda apagado.",
    del_lote: "«Plantilla (lote)» la enciende solo el lote: prográmalo en Registro.",
    aprobacion: "Para encenderlo hay que escribir el código de su aprobación, exactamente igual.",
    aprobacion_pendiente: "Su aprobación sigue pendiente: no se puede encender todavía.",
    mes_pronto: "Ese mes se puede aprobar 7 días después del pago del invitado.",
    tope: "El tope va de 0 a 200 US$, con hasta dos decimales.",
    lote: `No se programó el lote: ${motivo && SCHEDULE_REFUSALS.has(motivo) ? motivo : "revisa el estado"}.`,
    estado: "Ese cambio ya no se puede hacer (cambió el estado). Recarga la página.",
    datos: "Revisa los datos del formulario.",
    monto: "El monto no se entiende. Escríbelo como 19,99 o 19.527,03.",
    sin_vigencia: "No queda vigencia: primero registra un pago o extiende la fecha.",
    confirmar: "Para eliminar, escribe el nombre del negocio exactamente.",
    puntos: "No se pudieron quitar esos puntos. Revisa el número.",
    servidor: "No se pudo guardar. Revisa los logs.",
  };
  return known[code] ?? "No se pudo guardar el cambio.";
}

export type SectionParams = { ok?: string; error?: string; motivo?: string };
