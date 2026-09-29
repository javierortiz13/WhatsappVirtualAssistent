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
 */
export async function rateFor(
  db: Queryable,
  businessDate: IsoDate,
): Promise<{ rate: Rate; usedPriorDay: boolean }> {
  const found = rows<{ id: string; effective_date: string; rate: string }>(
    await db.execute(sql`
      select id, effective_date::text, rate::text from ${schema.bcvRate}
      where effective_date <= ${businessDate}::date
      order by effective_date desc limit 1
    `),
  );
  const r = found[0];
  if (!r) throw new NoRateError(businessDate);
  const effectiveDate = asIsoDate(r.effective_date);
  return { rate: rate(r.rate, effectiveDate, r.id), usedPriorDay: effectiveDate !== businessDate };
}
