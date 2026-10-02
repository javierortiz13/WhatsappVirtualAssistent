import { type Queryable, rows, schema, sql } from "@caja/db";
import { asIsoDate, type IsoDate } from "../domain/dates";
import { type Rate, rate } from "../domain/money";

export class NoRateError extends Error {
  constructor(readonly businessDate: IsoDate) {
    super(`no hay tasa BCV para ${businessDate} ni anterior`);
    this.name = "NoRateError";
  }
}

/**
 * Tasa vigente para una fecha de negocio: la mayor `effective_date <= fecha`. Fin de semana o
 * feriado usan la del último día hábil publicado; `usedPriorDay` lo indica para el resumen.
 * Si no existe ninguna hasta esa fecha (el sistema es nuevo y no tiene historia), usa la más
 * antigua publicada después: el borrador muestra la fecha de la tasa y el dueño la confirma.
 */
export async function rateFor(
  db: Queryable,
  businessDate: IsoDate,
): Promise<{ rate: Rate; usedPriorDay: boolean }> {
  const found = rows<{ id: string; effective_date: string; rate: string }>(
    await db.execute(sql`
      (select id, effective_date::text, rate::text, 0 as pref from ${schema.bcvRate}
        where effective_date <= ${businessDate}::date
        order by effective_date desc limit 1)
      union all
      (select id, effective_date::text, rate::text, 1 as pref from ${schema.bcvRate}
        where effective_date > ${businessDate}::date
        order by effective_date asc limit 1)
      order by pref limit 1
    `),
  );
  const r = found[0];
  if (!r) throw new NoRateError(businessDate);
  const effectiveDate = asIsoDate(r.effective_date);
  return { rate: rate(r.rate, effectiveDate, r.id), usedPriorDay: effectiveDate !== businessDate };
}

/** No hay tasa euro del BCV guardada para esa fecha ni antes. */
export class NoEurRateError extends Error {
  constructor(readonly businessDate: IsoDate) {
    super(`sin tasa euro BCV para ${businessDate}`);
    this.name = "NoEurRateError";
  }
}

/**
 * Tasa euro del BCV vigente en la fecha (la última publicada con euro en o antes de ese día). Se
 * usa cuando el negocio cobra o paga "a tasa euro": Bs = monto en $ × euro BCV. Las filas de
 * antes del 02/10/2026 no tienen euro: para esas fechas lanza y el agente pide la tasa.
 */
export async function euroRateFor(
  db: Queryable,
  businessDate: IsoDate,
): Promise<{ rate: Rate; usedPriorDay: boolean }> {
  const found = rows<{ id: string; effective_date: string; rate_eur: string }>(
    await db.execute(sql`
      select id, effective_date::text, rate_eur::text from ${schema.bcvRate}
      where rate_eur is not null and effective_date <= ${businessDate}::date
      order by effective_date desc limit 1
    `),
  );
  const r = found[0];
  if (!r) throw new NoEurRateError(businessDate);
  const effectiveDate = asIsoDate(r.effective_date);
  return {
    rate: rate(r.rate_eur, effectiveDate, r.id, "bcv_eur"),
    usedPriorDay: effectiveDate !== businessDate,
  };
}
