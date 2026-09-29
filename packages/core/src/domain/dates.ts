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
