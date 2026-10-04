import { type Queryable, rows, schema, sql } from "@caja/db";
import { addDays, asIsoDate, type IsoDate, weekday } from "../domain/dates";
import { Decimal } from "../domain/money";
import { NEXT_RATE_MAX_DAYS } from "../ledger/rate-for";
import type { RateInfo } from "../render/es-VE";

type RateRow = { effective_date: string; rate: string; which: string };

/**
 * "Vigente hoy": la misma regla que `rateFor` (la del día; sábado, domingo o feriado, la del
 * próximo día hábil ya publicada; si no, la última anterior). "Próxima" = la siguiente publicada
 * después de la vigente. Stale = la vigente tiene más de 3 días hábiles de antigüedad.
 */
export async function getRateInfo(db: Queryable, today: IsoDate): Promise<RateInfo> {
  const found = rows<RateRow>(
    await db.execute(sql`
      with cur as (
        select effective_date, rate from (
          (select effective_date, rate, 0 as pref from ${schema.bcvRate}
            where effective_date = ${today}::date)
          union all
          (select effective_date, rate, 1 as pref from ${schema.bcvRate}
            where effective_date > ${today}::date
              and effective_date <= ${today}::date + ${NEXT_RATE_MAX_DAYS}::int
            order by effective_date asc limit 1)
          union all
          (select effective_date, rate, 2 as pref from ${schema.bcvRate}
            where effective_date < ${today}::date
            order by effective_date desc limit 1)
        ) c order by pref limit 1
      )
      (select effective_date::text, rate::text, 'current' as which from cur)
      union all
      (select effective_date::text, rate::text, 'next' as which from ${schema.bcvRate}
        where effective_date > coalesce((select effective_date from cur), ${today}::date - 1)
          and effective_date > ${today}::date
        order by effective_date asc limit 1)
    `),
  );
  const pick = (which: string) => {
    const r = found.find((x) => x.which === which);
    return r ? { value: new Decimal(r.rate), effectiveDate: asIsoDate(r.effective_date) } : null;
  };
  const current = pick("current");
  return {
    current,
    next: pick("next"),
    stale: current ? businessDaysBetween(current.effectiveDate, today) > 3 : false,
  };
}

/** Cuenta días hábiles (lunes a viernes) estrictamente después de `from` hasta `to` inclusive. */
export function businessDaysBetween(from: IsoDate, to: IsoDate): number {
  let n = 0;
  let d = from;
  while (d < to) {
    d = addDays(d, 1);
    const w = weekday(d);
    if (w !== 0 && w !== 6) n += 1;
  }
  return n;
}
