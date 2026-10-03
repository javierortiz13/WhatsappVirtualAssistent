import { and, eq, rows, schema, sql, type Tx } from "@caja/db";
import { daysBetween, type IsoDate } from "../domain/dates";
import { Decimal } from "../domain/money";

/**
 * Presupuestos por categoría (0009): el dueño fija un tope en dólares, mensual (mes calendario) o
 * quincenal (1–15 y 16–fin de mes). Lo gastado se suma en vivo de los gastos de la categoría en la
 * ventana que contiene la fecha pedida, a su equivalente en $ (los gastos en Bs cuentan a la tasa
 * con que se guardaron). Lo que sobra no pasa al período siguiente.
 */
export type BudgetPeriod = (typeof schema.BUDGET_PERIODS)[number];

export const BUDGET_PERIOD_LABELS: Record<BudgetPeriod, string> = {
  monthly: "Mensual",
  biweekly: "Quincenal",
};

/** Desde este porcentaje el bot y el dashboard avisan en ámbar. */
export const BUDGET_WARN_PCT = 80;

export type BudgetStatus = {
  categoryId: string;
  name: string;
  period: BudgetPeriod;
  amountUsd: Decimal;
  spentUsd: Decimal;
  /** Negativo si se pasó. */
  remainingUsd: Decimal;
  /** Porcentaje usado, entero (redondeado hacia abajo para no alarmar antes de tiempo). */
  pct: number;
  from: IsoDate;
  to: IsoDate;
  /** Días que faltan contando la fecha pedida (1 = último día). */
  daysLeft: number;
};

export class BudgetError extends Error {
  constructor(public readonly code: "missing" | "invalid") {
    super(code);
    this.name = "BudgetError";
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/** La ventana del presupuesto que contiene `date`. */
export function budgetWindow(period: BudgetPeriod, date: IsoDate): { from: IsoDate; to: IsoDate } {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const ym = `${y}-${pad(m)}`;
  if (period === "monthly") return { from: `${ym}-01` as IsoDate, to: `${ym}-${last}` as IsoDate };
  return d <= 15
    ? { from: `${ym}-01` as IsoDate, to: `${ym}-15` as IsoDate }
    : { from: `${ym}-16` as IsoDate, to: `${ym}-${last}` as IsoDate };
}

type Row = {
  category_id: string;
  name: string;
  period: BudgetPeriod;
  amount_usd: string;
  spent_usd: string;
};

/**
 * Estado de los presupuestos de categorías activas en la fecha `date`, en el orden de las
 * categorías. Con `categoryIds`, solo esas. Una sola consulta: cada tope suma en su ventana.
 */
export async function budgetStatuses(
  tx: Tx,
  tenantId: string,
  date: IsoDate,
  categoryIds?: string[],
): Promise<BudgetStatus[]> {
  if (categoryIds && categoryIds.length === 0) return [];
  const month = budgetWindow("monthly", date);
  const half = budgetWindow("biweekly", date);
  const only = categoryIds
    ? sql`and b.category_id in (${sql.join(
        categoryIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql``;
  const list = rows<Row>(
    await tx.execute(sql`
      select b.category_id, c.name, b.period, b.amount_usd::text as amount_usd,
        coalesce((
          select sum(m.amount_usd) from ${schema.movement} m
          where m.tenant_id = b.tenant_id and m.type = 'expense' and m.category_id = b.category_id
            and m.deleted_at is null
            and m.business_date between
              (case when b.period = 'monthly' then ${month.from}::date else ${half.from}::date end)
              and (case when b.period = 'monthly' then ${month.to}::date else ${half.to}::date end)
        ), 0)::text as spent_usd
      from ${schema.budget} b
      join ${schema.category} c on c.id = b.category_id
      where b.tenant_id = ${tenantId} and c.is_active ${only}
      order by c.sort_order, c.name
    `),
  );
  return list.map((r) => {
    const amountUsd = new Decimal(r.amount_usd);
    const spentUsd = new Decimal(r.spent_usd);
    const w = r.period === "monthly" ? month : half;
    return {
      categoryId: r.category_id,
      name: r.name,
      period: r.period,
      amountUsd,
      spentUsd,
      remainingUsd: amountUsd.minus(spentUsd),
      pct: spentUsd.div(amountUsd).mul(100).floor().toNumber(),
      from: w.from,
      to: w.to,
      daysLeft: daysBetween(date, w.to) + 1,
    };
  });
}

/**
 * Fija, cambia o quita (monto null) el presupuesto de una categoría de gasto del negocio. Deja
 * auditoría con actor `user` y canal `dashboard`.
 */
export async function setBudget(
  tx: Tx,
  ref: { tenantId: string; userId: string },
  input: { categoryId: string; amountUsd: Decimal | null; period: BudgetPeriod },
): Promise<void> {
  const [cat] = await tx
    .select({ id: schema.category.id })
    .from(schema.category)
    .where(
      and(
        eq(schema.category.tenantId, ref.tenantId),
        eq(schema.category.id, input.categoryId),
        eq(schema.category.kind, "expense"),
      ),
    );
  if (!cat) throw new BudgetError("missing");
  const amount = input.amountUsd?.toDecimalPlaces(2, Decimal.ROUND_HALF_UP) ?? null;
  if (amount && (amount.lte(0) || amount.gt(10_000_000))) throw new BudgetError("invalid");

  const b = schema.budget;
  const [before] = await tx
    .select({ id: b.id, period: b.period, amountUsd: b.amountUsd })
    .from(b)
    .where(and(eq(b.tenantId, ref.tenantId), eq(b.categoryId, input.categoryId)));
  const prev = before ? { period: before.period, amountUsd: before.amountUsd } : null;

  if (!amount) {
    if (!before) return;
    await tx.delete(b).where(eq(b.id, before.id));
    await audit(tx, ref, "delete", before.id, prev, null);
    return;
  }
  const next = { period: input.period, amountUsd: amount.toFixed(2) };
  if (prev && prev.period === next.period && new Decimal(prev.amountUsd).eq(amount)) return;
  const [row] = await tx
    .insert(b)
    .values({ tenantId: ref.tenantId, categoryId: input.categoryId, ...next })
    .onConflictDoUpdate({
      target: [b.tenantId, b.categoryId],
      set: { ...next, updatedAt: new Date() },
    })
    .returning({ id: b.id });
  if (!row) throw new Error("no se pudo guardar el presupuesto");
  await audit(tx, ref, before ? "update" : "create", row.id, prev, next);
}

async function audit(
  tx: Tx,
  ref: { tenantId: string; userId: string },
  action: "create" | "update" | "delete",
  entityId: string,
  before: unknown,
  after: unknown,
) {
  await tx.insert(schema.auditLog).values({
    tenantId: ref.tenantId,
    actorType: "user",
    actorId: ref.userId,
    action,
    entity: "budget",
    entityId,
    before,
    after,
    channel: "dashboard",
  });
}
