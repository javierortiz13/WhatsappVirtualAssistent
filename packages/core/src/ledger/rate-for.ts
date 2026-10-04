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
 * Días hacia adelante en que se busca la tasa de un día sin publicación propia. El BCV publica el
 * viernes la del lunes; con feriados (Carnaval, Semana Santa) el salto llega a 4 días.
 */
export const NEXT_RATE_MAX_DAYS = 4;

/**
 * Tasa vigente para una fecha de negocio (corregido el 04/10/2026):
 * 1. la publicada para ese mismo día;
 * 2. si ese día no tiene (sábado, domingo o feriado), la del próximo día hábil ya publicada: en
 *    Venezuela el fin de semana se cobra a la tasa del lunes, que el BCV publica el viernes;
 * 3. si aún no está, la última anterior;
 * 4. sin historia (sistema nuevo), la más antigua posterior.
 * `usedPriorDay` (otro día que el pedido) lo indica para el resumen.
 */
export async function rateFor(
  db: Queryable,
  businessDate: IsoDate,
): Promise<{ rate: Rate; usedPriorDay: boolean }> {
  const found = rows<{ id: string; effective_date: string; rate: string }>(
    await db.execute(sql`
      (select id, effective_date::text, rate::text, 0 as pref from ${schema.bcvRate}
        where effective_date = ${businessDate}::date)
      union all
      (select id, effective_date::text, rate::text, 1 as pref from ${schema.bcvRate}
        where effective_date > ${businessDate}::date
          and effective_date <= ${businessDate}::date + ${NEXT_RATE_MAX_DAYS}::int
        order by effective_date asc limit 1)
      union all
      (select id, effective_date::text, rate::text, 2 as pref from ${schema.bcvRate}
        where effective_date < ${businessDate}::date
        order by effective_date desc limit 1)
      union all
      (select id, effective_date::text, rate::text, 3 as pref from ${schema.bcvRate}
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
 * Tasa euro del BCV vigente en la fecha, con la misma regla que `rateFor` (la del día; si no hay,
 * la del próximo día hábil ya publicada; si no, la última anterior). Se
 * usa cuando el negocio cobra o paga "a tasa euro": Bs = monto en $ × euro BCV. Las filas de
 * antes del 02/10/2026 no tienen euro: para esas fechas lanza y el agente pide la tasa.
 */
export async function euroRateFor(
  db: Queryable,
  businessDate: IsoDate,
): Promise<{ rate: Rate; usedPriorDay: boolean }> {
  const found = rows<{ id: string; effective_date: string; rate_eur: string }>(
    await db.execute(sql`
      (select id, effective_date::text, rate_eur::text, 0 as pref from ${schema.bcvRate}
        where rate_eur is not null and effective_date = ${businessDate}::date)
      union all
      (select id, effective_date::text, rate_eur::text, 1 as pref from ${schema.bcvRate}
        where rate_eur is not null and effective_date > ${businessDate}::date
          and effective_date <= ${businessDate}::date + ${NEXT_RATE_MAX_DAYS}::int
          -- Solo un día sin publicación propia: un día hábil con dólar y sin euro no salta.
          and not exists (select 1 from ${schema.bcvRate} where effective_date = ${businessDate}::date)
        order by effective_date asc limit 1)
      union all
      (select id, effective_date::text, rate_eur::text, 2 as pref from ${schema.bcvRate}
        where rate_eur is not null and effective_date < ${businessDate}::date
        order by effective_date desc limit 1)
      order by pref limit 1
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
