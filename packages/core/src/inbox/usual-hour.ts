import { rows, sql, type Tx } from "@caja/db";
import { addDays, businessDateOf } from "../domain/dates";

/**
 * Hora habitual (retención E1–E3, agencia 19/11 §1.3 y paso 2 del pedido): la mediana de la hora
 * del PRIMER movimiento (gasto o ingreso, de cualquier teléfono del negocio) de cada día con
 * registros en los últimos 28 días de Caracas, redondeada a 5 min hacia abajo y acotada a
 * 08:00–20:25. Con un solo día, ese día. Sin datos, 19:00. En minutos desde la medianoche.
 */
export const USUAL_MIN = 8 * 60;
export const USUAL_MAX = 20 * 60 + 25;
export const USUAL_DEFAULT = 19 * 60;
export const USUAL_DAYS = 28;

/** Minutos de Caracas de `now` desde la medianoche. */
export function caracasMinute(now: Date): number {
  const c = new Date(now.getTime() - 4 * 3_600_000);
  return c.getUTCHours() * 60 + c.getUTCMinutes();
}

/** La mediana de `minutes`, redondeada a 5 min hacia abajo y acotada; 19:00 sin datos. */
export function usualMinuteOf(minutes: number[]): number {
  if (!minutes.length) return USUAL_DEFAULT;
  const sorted = [...minutes].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  const rounded = Math.floor(median / 5) * 5;
  return Math.min(USUAL_MAX, Math.max(USUAL_MIN, rounded));
}

/** La hora del primer movimiento de cada día de los últimos 28 días de Caracas (hoy incluido). */
export async function firstMovementMinutes(tx: Tx, tenantId: string, now: Date): Promise<number[]> {
  const today = businessDateOf(now);
  const from = addDays(today, -(USUAL_DAYS - 1));
  const found = rows<{ m: number | string }>(
    await tx.execute(sql`
      select min(
        extract(hour from created_at at time zone 'America/Caracas') * 60
        + extract(minute from created_at at time zone 'America/Caracas')
      )::int as m
      from app.movement
      where tenant_id = ${tenantId} and deleted_at is null
        and (created_at at time zone 'America/Caracas')::date between ${from}::date and ${today}::date
      group by (created_at at time zone 'America/Caracas')::date
    `),
  );
  return found.map((r) => Number(r.m));
}

export async function usualMinute(tx: Tx, tenantId: string, now: Date): Promise<number> {
  return usualMinuteOf(await firstMovementMinutes(tx, tenantId, now));
}

/** «19:05» para /admin y las pruebas. */
export const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
