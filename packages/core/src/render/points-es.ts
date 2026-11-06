import {
  GIFTS,
  type GiftLine,
  LEVEL_MIN,
  LEVEL_NAMES,
  type Level,
  POINT_RULES,
  STREAK_BONUS,
} from "../billing/rewards";
import { formatShortDate, type IsoDate } from "../domain/dates";
import type { Outbound } from "./outbound";

/**
 * Textos de puntos, niveles y regalos (PRD hábitos v4.2.1, fase 4). **Solo** de
 * `agency/products/rocco/copy/rewards-strings-es-VE.md` v1.2 (agency `2e15c19`), palabra por
 * palabra; v1 y v1.1 no se pegan. Los nombres de nivel salen de `LEVEL_NAMES` (D17), siempre
 * después de «nivel». P4-A: ninguna línea de invitaciones (llegan con P4-B).
 */

/** Las reglas públicas (RW9, US-431). */
export const RULES_URL = "holarocco.com/puntos";

/** `1.200`, `3.000` (formato de los textos). */
export const pts = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const name = (l: Level) => LEVEL_NAMES[l];
const d = (iso: string | undefined) => (iso ? formatShortDate(iso as IsoDate) : "");

export const POINTS_BUTTONS = {
  how: { id: "pts:how", title: "Cómo sumar" },
  levels: { id: "pts:levels", title: "Niveles y regalos" },
  invite: { id: "pts:invite", title: "Invitar a alguien" },
} as const;

/** Qué filas se muestran (condición 3 de cumplimiento): con su interruptor y su aprobación. */
export type PointsFlags = { dailyClose: boolean; reminders: boolean; referrals: boolean };

// ---------------------------------------------------------------- RW1a, RW1b

/** RW1a «Cómo sumar» (chat). Sin `referrals` no hay bloque *Invitando* ni su botón. */
export function pointsHow(v: { business: boolean; flags: PointsFlags }): Outbound {
  const p = POINT_RULES;
  const daily = v.business
    ? `• Anotar cualquier movimiento ese día, tú o tu empleado (gasto, ingreso, venta, transferencia o cambio): +${p.record_day}`
    : `• Anotar cualquier movimiento ese día (gasto, ingreso, venta, transferencia o cambio): +${p.record_day}, anotes 1 o 20 cosas`;
  const once = [
    `• Terminar tu registro +${p.signup_done}`,
    `conectar tu panel +${p.panel_connected}`,
    `agregar 2 o más cuentas +${p.accounts_2}`,
    `tu primer presupuesto +${p.first_budget}`,
    ...(v.flags.reminders ? [`tu primer recordatorio +${p.first_reminder}`] : []),
    ...(v.business ? [`agregar un empleado, cuando acepte, +${p.employee_joined}`] : []),
  ].join(" · ");
  const lines = [
    "Así sumas puntos, pana:",
    "",
    "*Cada día*",
    daily,
    ...(v.flags.dailyClose
      ? [`• Tocar *Eso es todo* en el cierre de las 8 pm: +${p.close_day}`]
      : []),
    `• Racha de 7, 15 y 30 días seguidos: +${STREAK_BONUS[7]}, +${STREAK_BONUS[15]} y +${STREAK_BONUS[30]}, y se repite cada 30 días`,
    "",
    "*Una sola vez*",
    once,
    "",
    "*Lo que no suma*",
    "• «Hoy no gasté nada»: cuida tu racha, pero da 0 puntos",
    "• La racha da extra solo si anotaste algo en al menos la mitad de esos días",
    "• Saludar o preguntar",
    "• Si borras lo que anotaste ese mismo día, esos puntos se quitan",
    "",
    `Los puntos no se gastan ni valen dinero: solo te suben de nivel. Reglas: ${RULES_URL}`,
  ];
  return { type: "buttons", body: lines.join("\n"), buttons: [POINTS_BUTTONS.levels] };
}

/** RW1b «Niveles y regalos». */
export function pointsLevels(v: { trial: boolean }): Outbound {
  const lines = [
    "Estos son los niveles y el regalo de cada uno:",
    "",
    `• Nivel *${name(1)}* (desde 0): ahí arrancas`,
    `• Nivel *${name(2)}* (${pts(LEVEL_MIN[2])} puntos): +${GIFTS.msg2} mensajes${v.trial ? " en tu prueba" : ""}`,
    `• Nivel *${name(3)}* (${pts(LEVEL_MIN[3])}): +${GIFTS.msg3} mensajes, o ${GIFTS.dias3} días más si estás en la prueba`,
    `• Nivel *${name(4)}* (${pts(LEVEL_MIN[4])}): una semana de regalo, 7 días más en tu plan`,
    `• Nivel *${name(5)}* (${pts(LEVEL_MIN[5])}): ${GIFTS.pct5} % menos en tu plan mientras sigas pagando`,
    "",
    `Cada regalo llega una sola vez. Si este mes se agotan los regalos, el tuyo te llega el 1 del mes siguiente. Reglas: ${RULES_URL}`,
  ];
  return { type: "buttons", body: lines.join("\n"), buttons: [POINTS_BUTTONS.how] };
}

// ---------------------------------------------------------------- RW2, RW2-hold

/** La línea de subir de nivel (RW2), según cómo quedó el regalo. */
export function levelUpLine(g: GiftLine): string {
  const N = name(g.level);
  const head =
    g.level === 5
      ? `¡Epa, subiste al nivel *${N}*, el más alto!`
      : `¡Epa, subiste al nivel *${N}*!`;
  if (g.outcome === "paused" || g.outcome === "flag_off")
    return `${head} Tu regalo de este nivel queda guardado y te aviso aquí cuando llegue.`;
  if (g.outcome === "ceiling")
    return g.level === 4
      ? `${head} Este mes se agotaron los regalos de Rocco, así que tus 7 días de regalo se suman a tu plan el ${d(g.fechaTope)}.`
      : `${head} Este mes se agotaron los regalos de Rocco, así que tus *${g.k} mensajes* extra te llegan el ${d(g.fechaTope)}.`;
  if (g.outcome === "not_paying")
    return g.level === 3
      ? `${head} Tu prueba ya llegó a su tope, así que tus *${GIFTS.msg3} mensajes* de regalo te llegan cuando actives tu plan.`
      : `${head} Te regalé una semana: cuando pagues tu plan, te sumo 7 días más.`;
  if (g.level === 5)
    return `${head} Desde tu próximo pago, tu plan te sale *${GIFTS.pct5} % menos*, mientras sigas pagando.`;
  if (g.level === 4)
    return `${head} Te regalé una semana: sumé 7 días a tu plan, que ahora vence el ${d(g.fin)}.`;
  if (g.benefit === "trial_days")
    return `${head} Te sumé *${g.days} días* a tu prueba: ahora termina el ${d(g.fin)} o al llegar a los ${g.tope} mensajes, lo que llegue primero.`;
  return g.trial
    ? `${head} Te sumé *${g.k} mensajes* a tu prueba: ahora son ${g.tope}.`
    : `${head} Te regalé *${g.k} mensajes* extra, para usar hasta el ${d(g.vence)}.`;
}

// ---------------------------------------------------------------- RW8

/** RW8a-msgs / RW8a-week: el regalo que esperaba un pago, ya aplicado. */
export function giftPaidLine(g: GiftLine): string {
  if (g.benefit === "week")
    return `Tu semana de regalo del nivel *${name(4)}* ya está aplicada: sumé 7 días a tu plan, que ahora vence el ${d(g.fin)}.`;
  return `✅ Ya tienes tus *${g.k} mensajes* extra del nivel *${name(g.level)}*, para usar hasta el ${d(g.vence)}.`;
}

/** RW8b: detenido por el tope, fuera de una subida de nivel. */
export function giftHeldLine(g: GiftLine): string {
  if (g.level === 4)
    return `Este mes se agotaron los regalos de Rocco. Tus 7 días de regalo del nivel *${name(4)}* se suman a tu plan el ${d(g.fechaTope)}; no tienes que hacer nada.`;
  return `Este mes se agotaron los regalos de Rocco. Tus *${g.k ?? GIFTS.msg3} mensajes* del nivel *${name(g.level)}* te llegan el ${d(g.fechaTope)}; no tienes que hacer nada.`;
}

/** RW8b-arrive: llegó un regalo detenido o guardado. Leyenda no tiene texto (no se detiene). */
export function giftArrivedLine(g: GiftLine): string | null {
  if (g.benefit === "week")
    return `✅ Llegaron tus 7 días de regalo del nivel *${name(4)}*: tu plan ahora vence el ${d(g.fin)}.`;
  if (g.benefit !== "messages") return null;
  return g.trial
    ? `✅ Llegaron tus *${g.k} mensajes* extra del nivel *${name(g.level)}* a tu prueba: ahora son ${g.tope}.`
    : `✅ Llegaron tus *${g.k} mensajes* extra del nivel *${name(g.level)}*, para usar hasta el ${d(g.vence)}.`;
}

/** RW8a-ley: el 10 % en el aviso de pago verificado. */
export const leyendaPaidLine = () =>
  `Tu ${GIFTS.pct5} % menos del nivel *${name(5)}* ya está aplicado en este pago.`;

/** `{motivo}` de RW8h (lista fija para /admin). */
export const REMOVE_REASON_TEXT = {
  fake_records: "vimos movimientos anotados que no eran reales",
  fake_referral: "vimos una invitación hecha solo para sumar puntos",
  our_error: "te los sumamos por un error nuestro",
} as const;

/** RW8h: puntos quitados a mano (US-432). */
export const pointsRemovedLine = (
  k: number,
  motivo: keyof typeof REMOVE_REASON_TEXT,
  contacto: string,
) =>
  `Quitamos ${k} puntos de tu cuenta porque ${REMOVE_REASON_TEXT[motivo]}. Si crees que es un error, escríbenos a ${contacto}.`;

/** La línea pendiente (`points_notice`) en texto; null si no tiene texto (se descarta). */
export function noticeLine(
  n: { kind: string; args: Record<string, unknown> },
  contacto: string,
): string | null {
  const g = n.args as unknown as GiftLine;
  switch (n.kind) {
    case "level":
      return levelUpLine(g);
    case "gift_paid":
      return giftPaidLine(g);
    case "gift_held":
      return giftHeldLine(g);
    case "gift_arrived":
      return giftArrivedLine(g);
    case "leyenda_paid":
      return leyendaPaidLine();
    case "points_removed": {
      const a = n.args as { k?: number; motivo?: string };
      const motivo = a.motivo as keyof typeof REMOVE_REASON_TEXT;
      return a.k && REMOVE_REASON_TEXT[motivo] ? pointsRemovedLine(a.k, motivo, contacto) : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- RW3-B

export type CloseView = {
  today: number;
  total: number;
  level: Level;
  missing: number;
  next: Level | null;
  bonus: { points: number; n: number } | null;
  levelUp: GiftLine | null;
};

/** RW3-B: la respuesta a «Eso es todo» (A44), en lugar del ✅. */
export function closePointsLine(v: CloseView): string {
  const head = "✅ Listo, día cerrado.";
  if (v.levelUp) return `${head} ${levelUpLine(v.levelUp)}`;
  if (!v.next)
    return `${head} +${v.today} puntos hoy · estás en el nivel *${name(5)}* con ${pts(v.total)} puntos`;
  const left =
    v.missing === 1
      ? `te falta 1 para el nivel *${name(v.next)}*`
      : `te faltan ${pts(v.missing)} para el nivel *${name(v.next)}*`;
  if (v.today <= 0) return `${head} Hoy no sumaste puntos · ${left}`;
  if (v.bonus)
    return `${head} +${v.today} puntos hoy, con +${v.bonus.points} por tu racha de ${v.bonus.n} días · ${left}`;
  return `${head} +${v.today} puntos hoy · ${left}`;
}

// ---------------------------------------------------------------- RW4

/** El siguiente regalo, corto (`{premio_sig}`). */
export function nextGift(l: Level, trial: boolean): string {
  if (l === 2)
    return trial ? `${GIFTS.msg2} mensajes más en tu prueba` : `${GIFTS.msg2} mensajes extra`;
  if (l === 3) return trial ? `${GIFTS.dias3} días más de prueba` : `${GIFTS.msg3} mensajes extra`;
  if (l === 4) return "una semana de regalo: 7 días más en tu plan";
  return `${GIFTS.pct5} % menos en tu plan mientras sigas pagando`;
}

export type WaitingGift = {
  level: Level;
  reason: "ceiling" | "not_paying" | "flag_off" | "paused";
  fechaTope?: IsoDate;
};

export type MyPointsView = {
  total: number;
  today: number;
  level: Level;
  next: Level | null;
  missing: number;
  onlySetup: boolean;
  trial: boolean;
  leyendaEnded: boolean;
  waiting: WaitingGift[];
  dashboardUrl: string;
};

function waitingLine(w: WaitingGift): string {
  if (w.reason === "paused" || w.reason === "flag_off")
    return `Tu regalo del nivel *${name(w.level)}* está guardado; te aviso aquí cuando llegue.`;
  if (w.reason === "not_paying")
    return w.level === 4
      ? `Tus 7 días de regalo del nivel *${name(4)}* se suman cuando pagues tu plan.`
      : `Tus *${GIFTS.msg3} mensajes* del nivel *${name(3)}* te llegan cuando actives tu plan.`;
  return w.level === 4
    ? `Tus 7 días de regalo del nivel *${name(4)}* se suman a tu plan el ${d(w.fechaTope)}: este mes se agotaron los regalos.`
    : `Tus *${w.level === 2 ? GIFTS.msg2 : GIFTS.msg3} mensajes* del nivel *${name(w.level)}* te llegan el ${d(w.fechaTope)}: este mes se agotaron los regalos.`;
}

/** RW4 «mis puntos» (dueño). P4-A: sin línea ni botón de invitar. */
export function myPoints(v: MyPointsView): Outbound {
  const today = v.today > 0 ? `Hoy llevas +${v.today}.` : "Hoy todavía no llevas puntos.";
  const head: string[] = [];
  if (!v.next) {
    head.push(
      `Estás en el nivel *${name(5)}*, el más alto, con *${pts(v.total)} puntos*. ${today}`,
    );
    head.push(
      v.leyendaEnded
        ? `Tu ${GIFTS.pct5} % menos terminó porque tu plan estuvo suspendido más de 30 días.`
        : `Tu plan te sale ${GIFTS.pct5} % menos mientras sigas pagando.`,
    );
  } else if (v.level === 1 && v.onlySetup) {
    head.push(
      `Vas en el nivel *${name(1)}* con *${pts(v.total)} puntos*, por lo que ya configuraste.`,
    );
    head.push(
      `Te faltan *${pts(v.missing)}* para el nivel *${name(2)}*, que trae ${GIFTS.msg2} mensajes extra. Cada día que anotes algo sumas +${POINT_RULES.record_day}.`,
    );
  } else {
    head.push(`Vas en el nivel *${name(v.level)}* con *${pts(v.total)} puntos*. ${today}`);
    head.push(
      `Te faltan *${pts(v.missing)}* para el nivel *${name(v.next)}*, que trae ${nextGift(v.next, v.trial)}.`,
    );
  }
  const body = [
    head.join("\n"),
    ...v.waiting.map(waitingLine),
    `Todo el detalle, en tu panel: ${v.dashboardUrl}/logros\nLas reglas: ${RULES_URL}`,
  ].join("\n\n");
  return { type: "buttons", body, buttons: [POINTS_BUTTONS.how, POINTS_BUTTONS.levels] };
}

/** RW4 para un empleado (texto, sin botones). */
export const myPointsEmployee = (): Outbound => ({
  type: "text",
  body: "Los puntos son de la cuenta del negocio. Lo que tú anotas suma para esa cuenta.",
});

// ---------------------------------------------------------------- RW-help, RW-quote, PR-R4

/** RW-help (después de la línea «Avisos» de H51), con `xp` encendido. */
export const pointsHelpLine = "• Puntos: _mis puntos_ para ver tu nivel, tus puntos y cómo sumar";

/** RW-quote en el chat, después de la línea del fundador. */
export const leyendaQuoteLine = (founder: boolean) =>
  founder
    ? `Nivel *${name(5)}*: otro ${GIFTS.pct5} % menos, sobre el precio de fundador. También va descontado.`
    : `Nivel *${name(5)}*: ${GIFTS.pct5} % menos en tu plan mientras sigas pagando. Ya va descontado.`;

/** RW-quote en Ajustes → Plan. */
export const leyendaPlanLine = (founder: boolean) =>
  founder
    ? `Nivel ${name(5)}: otro ${GIFTS.pct5} % menos, sobre el precio de fundador. Los montos ya van descontados.`
    : `Nivel ${name(5)}: ${GIFTS.pct5} % menos en tu plan mientras sigas pagando. Los montos ya van descontados.`;

/** PR-R4 (corte de P4-A): una vez, en la próxima respuesta, después del despliegue. */
export const privacyNoticeP4 = (dashboardUrl: string) =>
  `_Actualizamos la política de privacidad por los puntos y los niveles. Léela en ${dashboardUrl}/privacidad_`;
