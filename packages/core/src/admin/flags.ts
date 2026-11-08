/**
 * Reglas de los interruptores de /admin (rediseño 08/11). Un solo lugar para lo que la hoja de
 * confirmación muestra y lo que el servidor valida: de qué depende cada uno, cuál pide aprobación
 * de la agencia (con su código exacto), cuál no se apaga y cuál no se toca a mano.
 *
 * Puro (sin base de datos): lo importan las server actions y los componentes del navegador.
 */

export type ApprovalStatus = "approved" | "pending";

/**
 * Aprobaciones de la agencia que exige cada interruptor (`agency/approvals.md`). Lista fija: cuando
 * la agencia apruebe una fila, se cambia aquí en un commit que ella confirma.
 */
export const APPROVALS = {
  "A-0033": { status: "approved" },
  "A-0037": { status: "pending" },
  "A-0038": { status: "pending" },
  "A-0039-T1": { status: "pending", target: "24/11" },
  "A-0039-T2": { status: "pending", target: "01/12" },
} as const satisfies Record<string, { status: ApprovalStatus; target?: string }>;

export type ApprovalId = keyof typeof APPROVALS;

export type AdminFlagKey =
  | "streakLine"
  | "noSpend"
  | "prefs"
  | "nudge"
  | "dailyClose"
  | "reminders"
  | "xp"
  | "rewards"
  | "referrals"
  | "inWindow"
  | "template"
  | "viaTemplate";

/** Grupo = la server action que lo guarda. */
export type FlagGroup = "habits" | "rewards" | "rescue";

export type FlagRule = {
  key: AdminFlagKey;
  group: FlagGroup;
  /** Sección de /admin/interruptores. */
  section: "Hábito" | "Puntos e invitaciones" | "Registro";
  title: string;
  desc: string;
  /** Interruptores que tienen que estar encendidos antes. */
  needs?: AdminFlagKey[];
  approval?: ApprovalId;
  /** Una vez encendido no se apaga. */
  sticky?: boolean;
  /** Lo enciende otra cosa (el lote); a mano solo se apaga, como freno. */
  managed?: string;
  /** No se puede encender. */
  blocked?: string;
};

export const FLAG_RULES: readonly FlagRule[] = [
  {
    key: "streakLine",
    group: "habits",
    section: "Hábito",
    title: "Línea de racha",
    desc: "En la primera tarjeta guardada del día y la tarjeta «Tu racha» en Inicio.",
  },
  {
    key: "noSpend",
    group: "habits",
    section: "Hábito",
    title: "«Hoy no gasté nada»",
    desc: "El día sin gastos cuenta para la racha.",
  },
  {
    key: "prefs",
    group: "habits",
    section: "Hábito",
    title: "Avisos: apagar y encender",
    desc: "«No me recuerdes», «no me escribas» y «mis avisos». Va primero y, una vez encendido, no se apaga.",
    sticky: true,
  },
  {
    key: "nudge",
    group: "habits",
    section: "Hábito",
    title: "Aviso de las 8 pm",
    desc: "La oferta en una tarjeta del dueño con racha de 3 a 7 días (una vez) y el aviso a quien lo acepte.",
    needs: ["prefs"],
    approval: "A-0033",
  },
  {
    key: "dailyClose",
    group: "habits",
    section: "Hábito",
    title: "8 pm para todos (cierre del día)",
    desc: "Sin que lo pidan: a quien escribió en las últimas 24 h, lo anotado hoy y «¿Falta algo?»; si no anotó nada, el aviso. Se apaga con «No me recuerdes».",
    needs: ["prefs", "nudge"],
    approval: "A-0038",
  },
  {
    key: "reminders",
    group: "habits",
    section: "Hábito",
    title: "Recordatorios de plata",
    desc: "Por chat y en el panel. Necesita la /privacidad nueva publicada.",
    needs: ["prefs"],
    approval: "A-0037",
  },
  {
    key: "xp",
    group: "rewards",
    section: "Puntos e invitaciones",
    title: "Puntos",
    desc: "Puntos y niveles, «mis puntos», «Mis logros» y la línea de «Eso es todo». Necesita /puntos publicado.",
    approval: "A-0039-T1",
  },
  {
    key: "rewards",
    group: "rewards",
    section: "Puntos e invitaciones",
    title: "Premios",
    desc: "Los regalos de cada nivel, con el tope del mes.",
    needs: ["xp"],
    approval: "A-0039-T1",
  },
  {
    key: "referrals",
    group: "rewards",
    section: "Puntos e invitaciones",
    title: "Invitaciones",
    desc: "Códigos, enlaces y el mes de regalo por invitar. Necesita la regla del firewall de Vercel en /w/* y ?ref=.",
    needs: ["xp"],
    approval: "A-0039-T2",
  },
  {
    key: "inWindow",
    group: "rescue",
    section: "Registro",
    title: "Recordatorio en la ventana",
    desc: "Si alguien deja el registro a medias, Rocco le escribe dentro de las 24 h.",
  },
  {
    key: "template",
    group: "rescue",
    section: "Registro",
    title: "Plantilla (lote)",
    desc: "Se enciende sola al programar el lote y se apaga al cancelarlo. Apagarlo frena un lote que está corriendo.",
    managed: "Lo controla el lote",
  },
  {
    key: "viaTemplate",
    group: "rescue",
    section: "Registro",
    title: "Recordatorio como plantilla",
    desc: "El recordatorio del registro como plantilla de Meta.",
    blocked: "No aprobado",
  },
];

export type FlagState = Record<AdminFlagKey, boolean>;

export const ruleOf = (key: AdminFlagKey): FlagRule => {
  const r = FLAG_RULES.find((f) => f.key === key);
  if (!r) throw new Error(`interruptor desconocido: ${key}`);
  return r;
};

/** Los que le faltan encendidos para poder encender `key`. */
export function missingNeeds(key: AdminFlagKey, state: FlagState): AdminFlagKey[] {
  return (ruleOf(key).needs ?? []).filter((k) => !state[k]);
}

/** Los encendidos que dependen de `key` (directa o indirectamente): se apagan con él. */
export function dependentsOn(key: AdminFlagKey, state: FlagState): AdminFlagKey[] {
  const out: AdminFlagKey[] = [];
  const visit = (k: AdminFlagKey) => {
    for (const r of FLAG_RULES)
      if (r.needs?.includes(k) && state[r.key] && !out.includes(r.key)) {
        out.push(r.key);
        visit(r.key);
      }
  };
  visit(key);
  return out;
}

export type FlagChangeError =
  /** «Avisos» no se apaga. */
  | "sticky"
  /** No aprobado: no se enciende. */
  | "blocked"
  /** Lo controla el lote: a mano no se enciende. */
  | "managed"
  /** Le falta otro interruptor encendido. */
  | "needs"
  /** Su aprobación sigue pendiente en la lista fija. */
  | "approval_pending"
  /** Falta el código de la aprobación, o no es exactamente igual. */
  | "approval_code";

/**
 * Lo que pasa al tocar un interruptor (la hoja): el estado nuevo con los que se apagan con él, o
 * por qué no se puede. `code` es lo que la persona escribió.
 */
export function applyFlagChange(
  state: FlagState,
  key: AdminFlagKey,
  on: boolean,
  code?: string | null,
):
  | { ok: true; next: FlagState; alsoOff: AdminFlagKey[]; approval: ApprovalId | null }
  | { ok: false; error: FlagChangeError; missing?: AdminFlagKey[] } {
  const rule = ruleOf(key);
  if (state[key] === on) return { ok: true, next: { ...state }, alsoOff: [], approval: null };
  if (!on) {
    if (rule.sticky) return { ok: false, error: "sticky" };
    const alsoOff = dependentsOn(key, state);
    const next = { ...state, [key]: false };
    for (const k of alsoOff) next[k] = false;
    return { ok: true, next, alsoOff, approval: null };
  }
  if (rule.blocked) return { ok: false, error: "blocked" };
  if (rule.managed) return { ok: false, error: "managed" };
  const missing = missingNeeds(key, state);
  if (missing.length) return { ok: false, error: "needs", missing };
  if (rule.approval) {
    if (APPROVALS[rule.approval].status !== "approved")
      return { ok: false, error: "approval_pending" };
    if ((code ?? "").trim() !== rule.approval) return { ok: false, error: "approval_code" };
  }
  return {
    ok: true,
    next: { ...state, [key]: true },
    alsoOff: [],
    approval: rule.approval ?? null,
  };
}

/**
 * Validación del servidor al guardar un grupo: compara el antes con el después que mandó el
 * formulario. Solo mira lo que cambia (un interruptor ya encendido con su aprobación pendiente se
 * queda como está), y que ningún encendido quede sin aquello de lo que depende.
 */
export function validateFlagSave(
  before: FlagState,
  after: FlagState,
  code?: string | null,
):
  | { ok: true; approval: ApprovalId | null }
  | { ok: false; error: FlagChangeError; key: AdminFlagKey } {
  let approval: ApprovalId | null = null;
  for (const rule of FLAG_RULES) {
    const k = rule.key;
    if (before[k] === after[k]) continue;
    if (!after[k]) {
      if (rule.sticky) return { ok: false, error: "sticky", key: k };
      continue;
    }
    if (rule.blocked) return { ok: false, error: "blocked", key: k };
    if (rule.managed) return { ok: false, error: "managed", key: k };
    if (rule.approval) {
      if (APPROVALS[rule.approval].status !== "approved")
        return { ok: false, error: "approval_pending", key: k };
      if ((code ?? "").trim() !== rule.approval)
        return { ok: false, error: "approval_code", key: k };
      approval = rule.approval;
    }
  }
  for (const rule of FLAG_RULES)
    if (after[rule.key] && (rule.needs ?? []).some((n) => !after[n]))
      return { ok: false, error: "needs", key: rule.key };
  return { ok: true, approval };
}
