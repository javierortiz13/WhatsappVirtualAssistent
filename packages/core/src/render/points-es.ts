import {
  GIFTS,
  type GiftLine,
  LEVEL_MIN,
  LEVEL_NAMES,
  type Level,
  POINT_RULES,
  STREAK_BONUS,
} from "../billing/rewards";
import { businessDateOf, formatShortDate, type IsoDate } from "../domain/dates";
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

// ---------------------------------------------------------------- RW1c, RW5 (panel «Mis logros»)

/** Fecha de los textos de las reglas (RW9 / RW5-8): se mueve cuando cambia su texto (P-16). */
export const POINTS_RULES_DATE = "2026-11-06" as IsoDate;

export type PanelRow = { action: string; points: string; note?: string; rule?: string };

/** RW1c: las filas de «Cómo sumar puntos», con los mismos cortes por interruptor que RW1a. */
export function pointsHowRows(v: { business: boolean; flags: PointsFlags }): {
  title: string;
  rows: PanelRow[];
}[] {
  const p = POINT_RULES;
  return [
    {
      title: "Cada día",
      rows: [
        {
          action: "Anotar cualquier movimiento en el día",
          points: `+${p.record_day}`,
          note: "Un gasto, un ingreso, una venta, una transferencia o un cambio. Cuenta una vez al día.",
        },
        ...(v.flags.dailyClose
          ? [
              {
                action: "Cerrar el día con «Eso es todo»",
                points: `+${p.close_day}`,
                note: "Los días que te llega el cierre de las 8 pm.",
              },
            ]
          : []),
        { action: "Racha de 7 días seguidos", points: `+${STREAK_BONUS[7]}` },
        { action: "Racha de 15 días seguidos", points: `+${STREAK_BONUS[15]}` },
        {
          action: "Racha de 30 días seguidos",
          points: `+${STREAK_BONUS[30]}`,
          note: "Se repite cada 30 días. La racha da extra solo si anotaste algo en al menos la mitad de esos días.",
        },
      ],
    },
    {
      title: "Una sola vez",
      rows: [
        { action: "Terminar tu registro", points: `+${p.signup_done}`, rule: "signup_done" },
        { action: "Conectar tu panel", points: `+${p.panel_connected}`, rule: "panel_connected" },
        {
          action: "Agregar 2 o más cuentas",
          points: `+${p.accounts_2}`,
          note: "Banco, efectivo, divisas…",
          rule: "accounts_2",
        },
        { action: "Tu primer presupuesto", points: `+${p.first_budget}`, rule: "first_budget" },
        ...(v.flags.reminders
          ? [
              {
                action: "Tu primer recordatorio",
                points: `+${p.first_reminder}`,
                rule: "first_reminder",
              },
            ]
          : []),
        ...(v.business
          ? [
              {
                action: "Agregar un empleado (negocio)",
                points: `+${p.employee_joined}`,
                note: "Cuenta cuando tu empleado acepta.",
                rule: "employee_joined",
              },
            ]
          : []),
      ],
    },
    {
      title: "Lo que no suma",
      rows: [
        { action: "«Hoy no gasté nada»", points: "0", note: "Cuida tu racha, pero no da puntos." },
        { action: "Saludar, preguntar, pedir la tasa", points: "0" },
        {
          action: "Borrar lo anotado ese mismo día",
          points: "—",
          note: "Los puntos de ese día se quitan.",
        },
      ],
    },
  ];
}

export const LOGROS = {
  title: "Mis logros",
  employee: "Los puntos y los regalos son de la cuenta del negocio.",
  yourLevel: "Tu nivel",
  howTitle: "Cómo sumar puntos",
  levelsTitle: "Niveles y regalos",
  rulesTitle: "Reglas de los puntos",
  done: "Hecho",
  badgeAlt: {
    1: "Insignia Cachorro: un pug cachorro",
    2: "Insignia Guardián: Rocco atento, vigilando",
    3: "Insignia Pana Fiel: Rocco sentado a tu lado",
    4: "Insignia Oro: Rocco con una medalla dorada",
    5: "Insignia Leyenda: Rocco con una corona",
  } as Record<Level, string>,
} as const;

/** RW5-1: «Nivel {nivel}», «{total} puntos», «Hoy: +{hoy}». */
export const logrosLevel = (l: Level) => `Nivel ${name(l)}`;
export const logrosTotal = (total: number) => `${pts(total)} puntos`;
export const logrosToday = (today: number) => (today > 0 ? `Hoy: +${today}` : null);

/** RW5-2: la barra. */
export function logrosBar(v: {
  total: number;
  next: Level | null;
  missing: number;
  trial: boolean;
  leyendaEnded: boolean;
}): { caption: string; aria: string | null; under: string } {
  if (!v.next)
    return {
      caption: "Llegaste al nivel más alto.",
      aria: null,
      under: v.leyendaEnded
        ? `Tu ${GIFTS.pct5} % menos terminó porque tu plan estuvo suspendido más de 30 días.`
        : `Tu regalo: ${GIFTS.pct5} % menos en tu plan mientras sigas pagando.`,
    };
  return {
    caption:
      v.missing === 1
        ? `Te falta 1 punto para el nivel ${name(v.next)}`
        : `Te faltan ${pts(v.missing)} puntos para el nivel ${name(v.next)}`,
    aria: `Progreso: ${pts(v.total)} de ${pts(LEVEL_MIN[v.next])} puntos para el nivel ${name(v.next)}`,
    under: `Al llegar: ${nextGift(v.next, v.trial)}`,
  };
}

/** RW1b sin `*`: el regalo de cada nivel, para el panel y /puntos. */
export function levelGiftText(l: Level, trial = false): string {
  if (l === 1) return "ahí arrancas";
  if (l === 2) return `+${GIFTS.msg2} mensajes${trial ? " en tu prueba" : ""}`;
  if (l === 3) return `+${GIFTS.msg3} mensajes, o ${GIFTS.dias3} días más si estás en la prueba`;
  if (l === 4) return "una semana de regalo, 7 días más en tu plan";
  return `${GIFTS.pct5} % menos en tu plan mientras sigas pagando`;
}

/** RW9: «Nivel Cachorro (desde 0): ahí arrancas» … */
export function levelLinePlain(l: Level): string {
  const from = l === 1 ? "desde 0" : l === 2 ? `${pts(LEVEL_MIN[2])} puntos` : pts(LEVEL_MIN[l]);
  return `Nivel ${name(l)} (${from}): ${levelGiftText(l)}`;
}

export type LevelChip = { chip: string | null; line: string };

/** RW5-4: el chip de cada nivel y su línea. */
export function levelChip(v: {
  level: Level;
  reached: boolean;
  missing: number;
  trial: boolean;
  grant: {
    status: string;
    waitReason: string | null;
    appliedAs: string | null;
    appliedAt: Date | null;
  } | null;
  vence: IsoDate;
  fechaTope: IsoDate;
  leyendaEnded: boolean;
}): LevelChip {
  if (v.level === 1) return { chip: null, line: "Ahí arrancas" };
  if (!v.reached) return { chip: "Por lograr", line: `Te faltan ${pts(v.missing)} puntos` };
  const g = v.grant;
  if (v.level === 5) {
    if (v.leyendaEnded)
      return {
        chip: "Terminado",
        line: "Terminó porque tu plan estuvo suspendido más de 30 días.",
      };
    if (g?.status === "waiting" && (g.waitReason === "flag_off" || g.waitReason === "paused"))
      return { chip: "Guardado", line: "Te avisamos cuando llegue." };
    return { chip: "Activo", line: `${GIFTS.pct5} % menos en cada pago, mientras sigas pagando` };
  }
  if (g?.status === "waiting") {
    if (g.waitReason === "ceiling")
      return {
        chip: "Pendiente por el tope",
        line: `Este mes se agotaron los regalos de Rocco. Te llega el ${d(v.fechaTope)}.`,
      };
    if (g.waitReason === "not_paying")
      return v.level === 4
        ? { chip: "Logrado", line: "Se suman cuando pagues tu plan" }
        : { chip: "Logrado", line: `Tus ${GIFTS.msg3} mensajes te llegan cuando actives tu plan` };
    return { chip: "Guardado", line: "Te avisamos cuando llegue." };
  }
  const since = g?.appliedAt ? d(businessDateOf(g.appliedAt)) : "";
  if (g?.appliedAs === "week")
    return { chip: "Aplicado", line: `7 días más en tu plan desde el ${since}` };
  if (g?.appliedAs === "trial_days")
    return { chip: "Aplicado", line: `${GIFTS.dias3} días más en tu prueba desde el ${since}` };
  const k = v.level === 2 ? GIFTS.msg2 : GIFTS.msg3;
  return v.trial
    ? { chip: "Logrado", line: `${k} mensajes más en tu prueba` }
    : { chip: "Logrado", line: `${k} mensajes extra, para usar hasta el ${d(v.vence)}` };
}

/** RW5-7: el estado vacío (solo puntos de la configuración). */
export const logrosEmpty = (total: number) =>
  `Ya tienes ${pts(total)} puntos por lo que configuraste. Anota algo en el chat y hoy sumas +${POINT_RULES.record_day}.`;

/**
 * Reversas como líneas (N-2). Los textos no tienen una línea propia para esto (ER, pregunta al
 * copywriter): se usan la fila de RW1c («Borrar lo anotado ese mismo día») y la primera frase de
 * RW8h, palabra por palabra.
 */
export function reversalLine(r: { points: number; reason: string; date: string }): string {
  const motivo = r.reason.startsWith("manual:")
    ? (r.reason.slice(7) as keyof typeof REMOVE_REASON_TEXT)
    : null;
  if (motivo && REMOVE_REASON_TEXT[motivo])
    return `−${pts(r.points)} · Quitamos ${r.points} puntos de tu cuenta porque ${REMOVE_REASON_TEXT[motivo]}. · ${d(r.date)}`;
  return `−${pts(r.points)} · Borrar lo anotado ese mismo día · ${d(r.date)}`;
}

/** RW5-8 / RW9: las reglas, con los cortes por interruptor (sin invitaciones en P4-A). */
export function pointsRules(flags: { dailyClose: boolean }): string[] {
  return [
    flags.dailyClose
      ? "Sumas puntos cuando anotas tus movimientos, cierras el día, mantienes tu racha y configuras Rocco por primera vez. No se suman por reseñas, por seguirnos en redes ni por compartir publicaciones."
      : "Sumas puntos cuando anotas tus movimientos, mantienes tu racha y configuras Rocco por primera vez. No se suman por reseñas, por seguirnos en redes ni por compartir publicaciones.",
    "Los puntos son de la cuenta y los ve solo su dueño. Los empleados no suman puntos propios: lo que anotan suma para la cuenta del negocio.",
    "Los puntos, los niveles y los regalos no tienen valor en efectivo: no se cambian por dinero, no se venden y no pasan a otra cuenta.",
    "Los puntos no se gastan. Cada nivel y su regalo llegan una sola vez, y tu nivel no baja.",
    `Los regalos son solo de Rocco: mensajes extra, días de prueba, días en tu plan y descuentos en tu plan. Los mensajes extra de un plan pagado valen hasta fin de mes. Si tu plan no está activo, los 7 días del nivel Oro se suman cuando lo pagues; y si tu prueba ya llegó a su tope de mensajes, los ${GIFTS.msg3} mensajes del nivel Pana Fiel te llegan cuando actives tu plan.`,
    "Rocco tiene un tope de regalos por mes para todos. Si este mes se agotan, el tuyo te llega el 1 del mes siguiente.",
    `El ${GIFTS.pct5} % menos del nivel Leyenda se aplica sobre lo que pagas, también con precio de fundador, mientras sigas pagando. Si tu plan se suspende y no vuelves a pagar en 30 días, se termina. Un pago que reportaste antes de que venciera tu plan cuenta aunque lo aprobemos después.`,
    "Si borras lo que anotaste un día, ese mismo día, los puntos de ese día se quitan. Si vemos movimientos falsos, podemos quitar esos puntos, y te avisamos por el chat. Los regalos que ya recibiste no se quitan.",
    "Podemos cambiar o terminar el programa avisándote en el panel y en el chat al menos 30 días antes; los regalos que ya tengas se respetan. Si hay un abuso o una falla, podemos pausar los regalos unos días; los pendientes te llegan después.",
  ];
}

/** RW9: la página pública de reglas. */
export const PUNTOS_PAGE = {
  title: "Reglas de los puntos · Rocco",
  /** Sin `referrals` (v1.2 S-3). */
  description:
    "Cómo se suman los puntos de Rocco, qué regalos trae cada nivel y cómo cambiamos el programa.",
  h1: "Reglas de los puntos",
  lead: "Estas son las reglas de los puntos, los niveles y los regalos de Rocco.",
  levelsTitle: "Niveles y regalos",
  rulesTitle: "Las reglas",
} as const;

/** «Última actualización: {fecha}» (P-16): lo más nuevo entre el texto y los cambios de interruptor. */
export function rulesUpdatedOn(dates: (IsoDate | null)[]): IsoDate {
  return dates.reduce<IsoDate>((a, b) => (b && b > a ? b : a), POINTS_RULES_DATE);
}

export const formatRulesDate = (iso: IsoDate) => formatShortDate(iso);

/** Umbral de un nivel (para la barra y la lista). */
export const levelMin = (l: Level) => LEVEL_MIN[l];
