import { and, eq, rows, schema, sql, type Tx } from "@caja/db";
import { addDays, type IsoDate, weekday } from "../domain/dates";
import { Decimal } from "../domain/money";
import { getRateInfo } from "../rates/current";
import type { PaymentMethod } from "./income";

/**
 * Cierre y consultas (Épica D). Todo se calcula en SQL sobre movimientos vivos del tenant, en
 * USD como unidad de cuenta; el equivalente en Bs del neto se muestra a la tasa vigente del
 * último día del período. El bot y el dashboard usan exactamente estas funciones.
 */
export type MethodTotal = { method: PaymentMethod; usd: Decimal; originalVes: Decimal };
export type CategoryTotal = { name: string; usd: Decimal; count: number };

export type DailyClose = {
  date: IsoDate;
  salesUsd: Decimal;
  salesByMethod: MethodTotal[];
  expensesUsd: Decimal;
  expensesByCategory: CategoryTotal[];
  netUsd: Decimal;
  netVes: Decimal | null;
  rateValue: Decimal | null;
  cashUsd: Decimal;
  cashVes: Decimal;
  count: number;
};

const num = (v: string | number | null | undefined) => new Decimal(v ?? 0);

export async function dailyClose(tx: Tx, tenantId: string, date: IsoDate): Promise<DailyClose> {
  const methods = rows<{ method: PaymentMethod; usd: string; ves: string }>(
    await tx.execute(sql`
      select payment_method as method,
             sum(amount_usd)::text as usd,
             coalesce(sum(amount) filter (where currency = 'VES'), 0)::text as ves
      from ${schema.movement}
      where tenant_id = ${tenantId} and type = 'income' and business_date = ${date}::date
        and deleted_at is null
      group by payment_method order by sum(amount_usd) desc
    `),
  );
  const categories = await expensesByCategory(tx, tenantId, date, date);
  const totals = rows<{ sales: string | null; expenses: string | null; count: string | number }>(
    await tx.execute(sql`
      select coalesce(sum(amount_usd) filter (where type = 'income'), 0)::text as sales,
             coalesce(sum(amount_usd) filter (where type = 'expense'), 0)::text as expenses,
             count(*) as count
      from ${schema.movement}
      where tenant_id = ${tenantId} and business_date = ${date}::date and deleted_at is null
    `),
  );
  const t = totals[0];
  const salesUsd = num(t?.sales);
  const expensesUsd = num(t?.expenses);
  const netUsd = salesUsd.minus(expensesUsd);
  const rate = (await getRateInfo(tx, date)).current;
  const cash = (m: PaymentMethod) => methods.find((x) => x.method === m);
  return {
    date,
    salesUsd,
    salesByMethod: methods.map((m) => ({
      method: m.method,
      usd: num(m.usd),
      originalVes: num(m.ves),
    })),
    expensesUsd,
    expensesByCategory: categories,
    netUsd,
    netVes: rate ? netUsd.mul(rate.value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP) : null,
    rateValue: rate?.value ?? null,
    cashUsd: num(cash("cash_usd")?.usd),
    cashVes: num(cash("cash_ves")?.ves),
    count: Number(t?.count ?? 0),
  };
}

export type PeriodSummary = {
  from: IsoDate;
  to: IsoDate;
  salesUsd: Decimal;
  expensesUsd: Decimal;
  netUsd: Decimal;
  topExpenses: CategoryTotal[];
  daysWithMovements: number;
  count: number;
};

export async function periodSummary(
  tx: Tx,
  tenantId: string,
  from: IsoDate,
  to: IsoDate,
): Promise<PeriodSummary> {
  const totals = rows<{
    sales: string | null;
    expenses: string | null;
    count: string | number;
    days: string | number;
  }>(
    await tx.execute(sql`
      select coalesce(sum(amount_usd) filter (where type = 'income'), 0)::text as sales,
             coalesce(sum(amount_usd) filter (where type = 'expense'), 0)::text as expenses,
             count(*) as count,
             count(distinct business_date) as days
      from ${schema.movement}
      where tenant_id = ${tenantId} and business_date between ${from}::date and ${to}::date
        and deleted_at is null
    `),
  );
  const t = totals[0];
  const salesUsd = num(t?.sales);
  const expensesUsd = num(t?.expenses);
  return {
    from,
    to,
    salesUsd,
    expensesUsd,
    netUsd: salesUsd.minus(expensesUsd),
    topExpenses: (await expensesByCategory(tx, tenantId, from, to)).slice(0, 5),
    daysWithMovements: Number(t?.days ?? 0),
    count: Number(t?.count ?? 0),
  };
}

async function expensesByCategory(
  tx: Tx,
  tenantId: string,
  from: IsoDate,
  to: IsoDate,
): Promise<CategoryTotal[]> {
  const found = rows<{ name: string | null; usd: string; count: string | number }>(
    await tx.execute(sql`
      select c.name, sum(m.amount_usd)::text as usd, count(*) as count
      from ${schema.movement} m
      left join ${schema.category} c on c.id = m.category_id
      where m.tenant_id = ${tenantId} and m.type = 'expense'
        and m.business_date between ${from}::date and ${to}::date and m.deleted_at is null
      group by c.name order by sum(m.amount_usd) desc
    `),
  );
  return found.map((r) => ({ name: r.name ?? "Otros", usd: num(r.usd), count: Number(r.count) }));
}

/** Total de una categoría en un período (US-D3); si no existe, devuelve las candidatas. */
/**
 * La categoría que el usuario nombró: igual sin acentos, una contiene a la otra, o comparten una
 * palabra de más de dos letras ("limpieza" → "Productos de limpieza").
 */
export function matchCategoryName<C extends { name: string }>(all: C[], name: string): C | null {
  const norm = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  const n = norm(name);
  if (!n) return null;
  const words = n.split(/\s+/).filter((w) => w.length > 2);
  return (
    all.find((c) => norm(c.name) === n) ??
    all.find((c) => norm(c.name).includes(n) || n.includes(norm(c.name))) ??
    all.find((c) => {
      const cw = norm(c.name).split(/\s+/);
      return words.some((w) => cw.includes(w));
    }) ??
    null
  );
}

export async function categoryTotal(
  tx: Tx,
  tenantId: string,
  from: IsoDate,
  to: IsoDate,
  name: string,
): Promise<
  | { found: true; name: string; usd: Decimal; ves: Decimal; count: number }
  | { found: false; suggestions: string[] }
> {
  const all = await tx
    .select({ id: schema.category.id, name: schema.category.name })
    .from(schema.category)
    .where(and(eq(schema.category.tenantId, tenantId), eq(schema.category.kind, "expense")));
  const match = matchCategoryName(all, name);
  if (!match) {
    return { found: false, suggestions: all.slice(0, 3).map((c) => c.name) };
  }
  const found = rows<{ usd: string | null; ves: string | null; count: string | number }>(
    await tx.execute(sql`
      select coalesce(sum(amount_usd), 0)::text as usd, coalesce(sum(amount_ves), 0)::text as ves,
             count(*) as count
      from ${schema.movement}
      where tenant_id = ${tenantId} and type = 'expense' and category_id = ${match.id}
        and business_date between ${from}::date and ${to}::date and deleted_at is null
    `),
  );
  return {
    found: true,
    name: match.name,
    usd: num(found[0]?.usd),
    ves: num(found[0]?.ves),
    count: Number(found[0]?.count ?? 0),
  };
}

// ---------------------------------------------------------------- períodos

export type PeriodKey =
  | "today"
  | "yesterday"
  | "this_week"
  | "last_week"
  | "this_month"
  | "last_month"
  | "custom";

export const MAX_PERIOD_DAYS = 366;

/** Semana de lunes a domingo; mes calendario. `custom` exige from y to. */
export function resolvePeriod(
  key: PeriodKey,
  today: IsoDate,
  custom: { from: IsoDate | null; to: IsoDate | null } = { from: null, to: null },
): { from: IsoDate; to: IsoDate } | { error: "missing" | "too_long" | "inverted" } {
  const monday = (d: IsoDate) => addDays(d, -((weekday(d) + 6) % 7));
  const firstOfMonth = (d: IsoDate) => `${d.slice(0, 7)}-01` as IsoDate;
  const lastOfMonth = (d: IsoDate) => {
    const [y, m] = d.split("-").map(Number);
    const last = new Date(Date.UTC(y ?? 2000, m ?? 1, 0)).getUTCDate();
    return `${d.slice(0, 7)}-${String(last).padStart(2, "0")}` as IsoDate;
  };
  switch (key) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case "this_week":
      return { from: monday(today), to: today };
    case "last_week": {
      const start = addDays(monday(today), -7);
      return { from: start, to: addDays(start, 6) };
    }
    case "this_month":
      return { from: firstOfMonth(today), to: today };
    case "last_month": {
      const prev = addDays(firstOfMonth(today), -1);
      return { from: firstOfMonth(prev), to: lastOfMonth(prev) };
    }
    default: {
      if (!custom.from || !custom.to) return { error: "missing" };
      if (custom.from > custom.to) return { error: "inverted" };
      const days = Math.round(
        (new Date(`${custom.to}T00:00:00Z`).getTime() -
          new Date(`${custom.from}T00:00:00Z`).getTime()) /
          86_400_000,
      );
      if (days > MAX_PERIOD_DAYS) return { error: "too_long" };
      return { from: custom.from, to: custom.to };
    }
  }
}
