import { type Queryable, rows, schema, sql } from "@caja/db";
import { addDays, asIsoDate, type IsoDate, weekday } from "../domain/dates.js";
import { Decimal } from "../domain/money.js";
import type { RateInfo } from "../render/es-VE.js";

type RateRow = { effective_date: string; rate: string; which: string };

/**
 * "Vigente hoy" = mayor effective_date <= hoy. "Próxima" = menor effective_date > hoy.
 * Stale = la vigente tiene más de 3 días hábiles de antigüedad (feriados no contados).
 */
export async function getRateInfo(db: Queryable, today: IsoDate): Promise<RateInfo> {
  const found = rows<RateRow>(
    await db.execute(sql`
      (select effective_date::text, rate::text, 'current' as which
         from ${schema.bcvRate} where effective_date <= ${today}::date
        order by effective_date desc limit 1)
      union all
      (select effective_date::text, rate::text, 'next' as which
         from ${schema.bcvRate} where effective_date > ${today}::date
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
