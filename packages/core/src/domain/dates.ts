/**
 * Fechas de negocio. `business_date` es un string ISO `YYYY-MM-DD` en hora de Caracas.
 * Los instantes son `Date` en UTC. Nunca se deriva uno del otro fuera de este módulo.
 */
export const CARACAS_TZ = "America/Caracas";

const partsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: CARACAS_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export type IsoDate = string & { readonly __brand: "IsoDate" };

export function isIsoDate(s: string): s is IsoDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function asIsoDate(s: string): IsoDate {
  if (!isIsoDate(s)) throw new Error(`fecha inválida: ${s}`);
  return s;
}

/** Fecha de negocio (Caracas) de un instante. */
export function businessDateOf(instant: Date): IsoDate {
  return partsFormatter.format(instant) as IsoDate;
}

export function todayInCaracas(now: () => Date = () => new Date()): IsoDate {
  return businessDateOf(now());
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10) as IsoDate;
}

export function daysBetween(a: IsoDate, b: IsoDate): number {
  const ms = new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime();
  return Math.round(ms / 86_400_000);
}

/** 0 = domingo … 6 = sábado. */
export function weekday(date: IsoDate): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export function isWeekend(date: IsoDate): boolean {
  const w = weekday(date);
  return w === 0 || w === 6;
}

const WEEKDAYS_ES = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] as const;
const MONTHS_ES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

/** "lun 29/09" */
export function formatShortDate(date: IsoDate): string {
  const [, m, d] = date.split("-");
  return `${WEEKDAYS_ES[weekday(date)]} ${d}/${m}`;
}

/** "Septiembre" */
export function monthNameEs(date: IsoDate): string {
  const m = Number(date.slice(5, 7)) - 1;
  const name = MONTHS_ES[m] ?? "";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Fechas relativas al hablar: hoy, ayer, antier, "el lunes" (el más reciente, incluido hoy).
 */
export function resolveRelativeDate(word: string, today: IsoDate): IsoDate | null {
  const w = word.trim().toLowerCase();
  if (w === "hoy") return today;
  if (w === "ayer") return addDays(today, -1);
  if (w === "antier" || w === "anteayer") return addDays(today, -2);
  const names: Record<string, number> = {
    domingo: 0,
    lunes: 1,
    martes: 2,
    miercoles: 3,
    miércoles: 3,
    jueves: 4,
    viernes: 5,
    sabado: 6,
    sábado: 6,
  };
  const target = names[w.replace(/^el\s+/, "")];
  if (target === undefined) return null;
  const diff = (weekday(today) - target + 7) % 7;
  return addDays(today, -diff);
}

// ---------------------------------------------------------------- recordatorios: fechas hacia adelante

/** Último día del mes de `date`. */
export function lastDayOfMonth(date: IsoDate): IsoDate {
  const [y, m] = date.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10) as IsoDate;
}

/** Día `day` del mes `month0` (0–11) de `year`, o el último día si ese mes tiene menos. */
function dayInMonth(year: number, month0: number, day: number): IsoDate {
  const first = new Date(Date.UTC(year, month0, 1)).toISOString().slice(0, 10) as IsoDate;
  const last = Number(lastDayOfMonth(first).slice(8, 10));
  return new Date(Date.UTC(year, month0, Math.min(day, last)))
    .toISOString()
    .slice(0, 10) as IsoDate;
}

/** Instante UTC de una hora de Caracas (UTC−4, sin horario de verano). */
export function caracasInstant(date: IsoDate, hour: number, minute = 0): Date {
  return new Date(
    Date.UTC(
      ...((date.split("-").map(Number) as [number, number, number]).map((v, i) =>
        i === 1 ? v - 1 : v,
      ) as [number, number, number]),
      hour + 4,
      minute,
    ),
  );
}

export type DueAt =
  | { kind: "ok"; dueAt: Date; dueDate: IsoDate; timeWasDefault: boolean }
  /** 7 a 11 sin "am" ni "pm": ¿de la mañana o de la noche? (H17) */
  | { kind: "ambiguous_hour"; hour: number; minute: number; date: IsoDate | null }
  /** No dijo el día (H18). */
  | { kind: "no_date" }
  /** La fecha ya pasó (H18b). */
  | { kind: "past" }
  /** Hoy, pero la hora ya pasó (H18c). */
  | { kind: "hour_passed"; hour: number; minute: number }
  /** Más de un año adelante (H18d). */
  | { kind: "too_far" };

const DUE_WEEKDAYS: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
};
const DUE_MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];
const NUMBER_WORDS: Record<string, number> = {
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  quince: 15,
};
const DEFAULT_HOUR = 9;

function plain(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** La fecha dicha, hacia adelante; null si no dijo ninguna. `explicitPast` si la dijo y ya pasó. */
function dueDate(t: string, today: IsoDate): { date: IsoDate | null; past: boolean } {
  if (/\bpasado manana\b/.test(t)) return { date: addDays(today, 2), past: false };
  // "mañana" es el día; "de la mañana" es la hora ("mañana a las 9 de la mañana").
  if (/\bmanana\b/.test(t.replace(/\b(de|en|por) la manana\b/g, " ")))
    return { date: addDays(today, 1), past: false };
  if (/\bhoy\b|\besta (noche|tarde)\b/.test(t)) return { date: today, past: false };
  if (/\bfin(al)? de mes\b|\bultimo (dia )?del mes\b/.test(t))
    return { date: lastDayOfMonth(today), past: false };
  if (/\bquincena\b/.test(t)) {
    const fifteen = dayInMonth(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 15);
    return { date: today <= fifteen ? fifteen : lastDayOfMonth(today), past: false };
  }
  const inN = /\b(?:en|dentro de) (\d{1,3}|[a-z]+) (dia|dias|semana|semanas)\b/.exec(t);
  if (inN) {
    const n = Number(inN[1]) || NUMBER_WORDS[inN[1] as string] || 0;
    if (n) return { date: addDays(today, inN[2]?.startsWith("semana") ? n * 7 : n), past: false };
  }
  if (/\b(la )?(proxima semana|semana que viene)\b/.test(t))
    return { date: addDays(today, 7), past: false };
  const wd =
    /\b(?:el |este |proximo |el proximo )?(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/.exec(
      t,
    );
  if (wd) {
    const target = DUE_WEEKDAYS[wd[1] as string] as number;
    const diff = (target - weekday(today) + 7) % 7;
    const next = /\bproximo\b/.test(wd[0]) && diff === 0 ? 7 : diff;
    return { date: addDays(today, next), past: false };
  }
  const y = Number(today.slice(0, 4));
  const m0 = Number(today.slice(5, 7)) - 1;
  const num = /\b(\d{1,2})\s*[/-]\s*(\d{1,2})(?:\s*[/-]\s*(\d{2,4}))?\b/.exec(t);
  const named = new RegExp(`\\b(\\d{1,2}) de (${DUE_MONTHS.join("|")})(?: del? (\\d{4}))?\\b`).exec(
    t,
  );
  const dm = num ?? named;
  if (dm) {
    const day = Number(dm[1]);
    const monthTxt = dm[2] as string;
    const month0 = /^\d+$/.test(monthTxt) ? Number(monthTxt) - 1 : DUE_MONTHS.indexOf(monthTxt);
    const yearTxt = dm[3];
    const year = yearTxt ? (yearTxt.length === 2 ? 2000 + Number(yearTxt) : Number(yearTxt)) : null;
    if (month0 >= 0 && month0 < 12 && day >= 1 && day <= 31) {
      let date = dayInMonth(year ?? y, month0, day);
      if (date < today) {
        // Sin año, un mes que ya pasó es del año que viene ("el 5 de enero" dicho en noviembre).
        if (!year && month0 < m0) date = dayInMonth(y + 1, month0, day);
        else return { date, past: true };
      }
      return { date, past: false };
    }
  }
  const d = /\b(?:el|para el|dia) (\d{1,2})\b(?! ?(?:am|pm|de la|:|h\b))/.exec(t);
  if (d) {
    const day = Number(d[1]);
    if (day >= 1 && day <= 31) {
      const thisMonth = dayInMonth(y, m0, day);
      return { date: thisMonth >= today ? thisMonth : dayInMonth(y, m0 + 1, day), past: false };
    }
  }
  return { date: null, past: false };
}

/** La hora dicha; null si no dijo ninguna. `ambiguous` si es 7–11 sin am/pm. */
function dueTime(t: string): { hour: number; minute: number; ambiguous: boolean } | null {
  if (/\bmedio ?dia\b/.test(t)) return { hour: 12, minute: 0, ambiguous: false };
  const hm =
    /\b(?:a las |a la |las |la )?(\d{1,2})(?::(\d{2}))?\s*(am|a\.?\s?m\.?|pm|p\.?\s?m\.?|de la manana|de la tarde|de la noche|en la manana|en la tarde|en la noche)?\b/.exec(
      t
        .replace(/\b(?:el|para el|dia) \d{1,2}\b(?! ?(?:am|pm|de la|:))/g, " ")
        .replace(/\b\d{1,2}\s*[/-]\s*\d{1,2}(?:\s*[/-]\s*\d{2,4})?\b/g, " ")
        .replace(
          new RegExp(`\\b\\d{1,2} de (?:${DUE_MONTHS.join("|")})(?: del? \\d{4})?\\b`, "g"),
          " ",
        )
        .replace(/\b(?:en|dentro de) \d{1,3} (?:dia|dias|semana|semanas)\b/g, " "),
    );
  const hasClock = hm && (hm[2] !== undefined || hm[3] !== undefined || /\blas? \d/.test(hm[0]));
  if (hm && hasClock) {
    const hour = Number(hm[1]);
    const minute = Number(hm[2] ?? 0);
    if (hour > 23 || minute > 59) return null;
    const marker = hm[3] ?? "";
    if (/^p|tarde|noche/.test(marker))
      return { hour: hour < 12 ? hour + 12 : hour, minute, ambiguous: false };
    if (/^a|manana/.test(marker)) return { hour: hour === 12 ? 0 : hour, minute, ambiguous: false };
    if (hour === 12 || hour >= 13) return { hour, minute, ambiguous: false };
    if (hour >= 1 && hour <= 6) return { hour: hour + 12, minute, ambiguous: false };
    if (hour >= 7 && hour <= 11) return { hour, minute, ambiguous: true };
    return null;
  }
  if (/\b(en la|esta|por la) noche\b/.test(t)) return { hour: 20, minute: 0, ambiguous: false };
  if (/\b(en la|esta|por la) tarde\b/.test(t)) return { hour: 15, minute: 0, ambiguous: false };
  if (/\b(en la|por la) manana\b/.test(t)) return { hour: 9, minute: 0, ambiguous: false };
  return null;
}

/**
 * Cuándo avisar un recordatorio (PRD hábitos US-302): la frase en español, siempre hacia adelante,
 * en hora de Caracas. Sin hora, las 9 am (y se dice). 7 a 11 sin am/pm se pregunta. Más de un año
 * adelante no. Distinto de `resolveRelativeDate`, que mira hacia atrás.
 */
export function resolveDueAt(phrase: string, now: Date): DueAt {
  const t = plain(phrase);
  const today = businessDateOf(now);
  const { date, past } = dueDate(t, today);
  if (past) return { kind: "past" };
  const time = dueTime(t);
  if (time?.ambiguous)
    return { kind: "ambiguous_hour", hour: time.hour, minute: time.minute, date };
  // Solo la hora ("a las 3 pm"): hoy.
  const day = date ?? (time ? today : null);
  if (!day) return { kind: "no_date" };
  if (daysBetween(today, day) > 366) return { kind: "too_far" };
  const hour = time?.hour ?? DEFAULT_HOUR;
  const minute = time?.minute ?? 0;
  const dueAt = caracasInstant(day, hour, minute);
  if (dueAt.getTime() <= now.getTime()) {
    if (day === today) return { kind: "hour_passed", hour, minute };
    return { kind: "past" };
  }
  return { kind: "ok", dueAt, dueDate: day, timeWasDefault: !time };
}
