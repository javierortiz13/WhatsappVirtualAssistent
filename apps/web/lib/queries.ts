import "server-only";
import { Decimal, type IsoDate, todayInCaracas } from "@caja/core/domain";
import { and, desc, eq, gte, isNull, lte, rows, schema, sql, withTenant } from "@caja/db";
import { db } from "./db";

/**
 * Consultas del dashboard. Todas corren bajo `withTenant`, así que RLS acota cada fila al
 * negocio de la sesión. Las cifras salen de las mismas tablas que alimentan al bot.
 */
export type MovementRow = {
  id: string;
  type: string;
  businessDate: string;
  amount: string;
  currency: string;
  amountUsd: string;
  amountVes: string;
  rateValue: string;
  description: string | null;
  categoryName: string | null;
  sourceChannel: string;
  attachmentId: string | null;
  createdAt: Date;
};

export function monthBounds(today: IsoDate): { from: IsoDate; to: IsoDate; label: string } {
  const [y, m] = today.split("-");
  const from = `${y}-${m}-01` as IsoDate;
  const lastDay = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
  const to = `${y}-${m}-${String(lastDay).padStart(2, "0")}` as IsoDate;
  return { from, to, label: `${y}-${m}` };
}

export async function movementsBetween(
  tenantId: string,
  from: IsoDate,
  to: IsoDate,
  limit = 500,
): Promise<MovementRow[]> {
  return withTenant(db(), tenantId, (tx) =>
    tx
      .select({
        id: schema.movement.id,
        type: schema.movement.type,
        businessDate: schema.movement.businessDate,
        amount: schema.movement.amount,
        currency: schema.movement.currency,
        amountUsd: schema.movement.amountUsd,
        amountVes: schema.movement.amountVes,
        rateValue: schema.movement.rateValue,
        description: schema.movement.description,
        categoryName: schema.category.name,
        sourceChannel: schema.movement.sourceChannel,
        attachmentId: schema.movement.attachmentId,
        createdAt: schema.movement.createdAt,
      })
      .from(schema.movement)
      .leftJoin(schema.category, eq(schema.category.id, schema.movement.categoryId))
      .where(
        and(
          isNull(schema.movement.deletedAt),
          gte(schema.movement.businessDate, from),
          lte(schema.movement.businessDate, to),
        ),
      )
      .orderBy(desc(schema.movement.businessDate), desc(schema.movement.createdAt))
      .limit(limit),
  );
}

export type Totals = { expensesUsd: Decimal; expenseCount: number; incomeUsd: Decimal };

export async function totalsBetween(tenantId: string, from: IsoDate, to: IsoDate): Promise<Totals> {
  const [row] = await withTenant(db(), tenantId, async (tx) =>
    rows<{ expenses: string | null; n: string; income: string | null }>(
      await tx.execute(sql`
        select
          coalesce(sum(amount_usd) filter (where type = 'expense'), 0)::text as expenses,
          count(*) filter (where type = 'expense')::text as n,
          coalesce(sum(amount_usd) filter (where type = 'income'), 0)::text as income
        from ${schema.movement}
        where deleted_at is null and business_date between ${from}::date and ${to}::date
      `),
    ),
  );
  return {
    expensesUsd: new Decimal(row?.expenses ?? 0),
    expenseCount: Number(row?.n ?? 0),
    incomeUsd: new Decimal(row?.income ?? 0),
  };
}

export { todayInCaracas };
