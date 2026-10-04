import "server-only";
import { Decimal, type IsoDate, todayInCaracas } from "@caja/core/domain";
import {
  and,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  lte,
  rows,
  schema,
  sql,
  withTenant,
} from "@caja/db";
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
  paymentMethod: string;
  attachmentId: string | null;
  createdAt: Date;
  deletedAt: Date | null;
};

/** "2026-09" → límites del mes; `shiftMonth` mueve N meses. */
export function monthOf(ym: string): { from: IsoDate; to: IsoDate; label: string } {
  const [y, m] = ym.split("-");
  return monthBounds(`${y}-${m}-01` as IsoDate);
}

export function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y as number, (m as number) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export type MovementFilter = { type?: "expense" | "income"; deleted?: boolean };

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
  filter: MovementFilter = {},
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
        paymentMethod: schema.movement.paymentMethod,
        attachmentId: schema.movement.attachmentId,
        createdAt: schema.movement.createdAt,
        deletedAt: schema.movement.deletedAt,
      })
      .from(schema.movement)
      .leftJoin(schema.category, eq(schema.category.id, schema.movement.categoryId))
      .where(
        and(
          filter.deleted ? isNotNull(schema.movement.deletedAt) : isNull(schema.movement.deletedAt),
          filter.type ? eq(schema.movement.type, filter.type) : undefined,
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

/** Neto (ventas − gastos, USD) por día del rango; los días sin movimientos no aparecen. */
export async function dailyNets(
  tenantId: string,
  from: IsoDate,
  to: IsoDate,
): Promise<{ date: string; net: Decimal; sales: Decimal; expenses: Decimal }[]> {
  const list = await withTenant(db(), tenantId, async (tx) =>
    rows<{ date: string; sales: string; expenses: string }>(
      await tx.execute(sql`
        select business_date::text as date,
               coalesce(sum(amount_usd) filter (where type = 'income'), 0)::text as sales,
               coalesce(sum(amount_usd) filter (where type = 'expense'), 0)::text as expenses
        from ${schema.movement}
        where deleted_at is null and business_date between ${from}::date and ${to}::date
        group by business_date order by business_date
      `),
    ),
  );
  return list.map((r) => {
    const sales = new Decimal(r.sales);
    const expenses = new Decimal(r.expenses);
    return { date: r.date, sales, expenses, net: sales.minus(expenses) };
  });
}

export type MovementDetail = MovementRow & {
  categoryId: string | null;
  accountId: string | null;
  accountName: string | null;
  origin: string;
  rateSource: string;
  updatedAt: Date;
  author: string;
  sourceBody: string | null;
  attachmentMime: string | null;
};

/** Un movimiento con su categoría, autor (teléfono o cuenta) y el mensaje que lo originó. */
export async function movementById(tenantId: string, id: string): Promise<MovementDetail | null> {
  const [m] = await withTenant(db(), tenantId, (tx) =>
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
        rateSource: schema.movement.rateSource,
        description: schema.movement.description,
        categoryId: schema.movement.categoryId,
        categoryName: schema.category.name,
        sourceChannel: schema.movement.sourceChannel,
        paymentMethod: schema.movement.paymentMethod,
        origin: schema.movement.origin,
        attachmentId: schema.movement.attachmentId,
        createdAt: schema.movement.createdAt,
        updatedAt: schema.movement.updatedAt,
        deletedAt: schema.movement.deletedAt,
        phoneName: schema.phoneNumber.displayName,
        phoneE164: schema.phoneNumber.e164,
        userEmail: schema.userAccount.email,
        sourceBody: schema.message.body,
        attachmentMime: schema.attachment.mimeType,
        accountId: schema.movement.accountId,
        accountName: schema.account.name,
      })
      .from(schema.movement)
      .leftJoin(schema.category, eq(schema.category.id, schema.movement.categoryId))
      .leftJoin(schema.account, eq(schema.account.id, schema.movement.accountId))
      .leftJoin(schema.phoneNumber, eq(schema.phoneNumber.id, schema.movement.createdByPhoneId))
      .leftJoin(schema.userAccount, eq(schema.userAccount.id, schema.movement.createdByUserId))
      .leftJoin(schema.message, eq(schema.message.id, schema.movement.sourceMessageId))
      .leftJoin(schema.attachment, eq(schema.attachment.id, schema.movement.attachmentId))
      .where(eq(schema.movement.id, id)),
  );
  if (!m) return null;
  const { phoneName, phoneE164, userEmail, ...rest } = m;
  return {
    ...rest,
    author: phoneName ?? (phoneE164 ? `+${phoneE164}` : (userEmail ?? "—")),
  };
}

export async function categoriesOf(tenantId: string): Promise<{ id: string; name: string }[]> {
  return withTenant(db(), tenantId, (tx) =>
    tx
      .select({ id: schema.category.id, name: schema.category.name })
      .from(schema.category)
      .where(and(eq(schema.category.kind, "expense"), eq(schema.category.isActive, true)))
      .orderBy(schema.category.sortOrder),
  );
}

export type ExportRow = {
  businessDate: string;
  type: string;
  categoryName: string | null;
  description: string | null;
  amount: string;
  currency: string;
  rateValue: string;
  amountUsd: string;
  amountVes: string;
  paymentMethod: string;
  accountName: string | null;
  author: string;
  sourceChannel: string;
};

/** Filas para el .xlsx (US-E3): movimientos vivos del rango, más antiguos primero. */
export async function exportRows(
  tenantId: string,
  from: IsoDate,
  to: IsoDate,
): Promise<ExportRow[]> {
  const list = await withTenant(db(), tenantId, (tx) =>
    tx
      .select({
        businessDate: schema.movement.businessDate,
        type: schema.movement.type,
        categoryName: schema.category.name,
        description: schema.movement.description,
        amount: schema.movement.amount,
        currency: schema.movement.currency,
        rateValue: schema.movement.rateValue,
        amountUsd: schema.movement.amountUsd,
        amountVes: schema.movement.amountVes,
        paymentMethod: schema.movement.paymentMethod,
        accountName: schema.account.name,
        sourceChannel: schema.movement.sourceChannel,
        phoneName: schema.phoneNumber.displayName,
        phoneE164: schema.phoneNumber.e164,
        userEmail: schema.userAccount.email,
        createdAt: schema.movement.createdAt,
      })
      .from(schema.movement)
      .leftJoin(schema.category, eq(schema.category.id, schema.movement.categoryId))
      .leftJoin(schema.account, eq(schema.account.id, schema.movement.accountId))
      .leftJoin(schema.phoneNumber, eq(schema.phoneNumber.id, schema.movement.createdByPhoneId))
      .leftJoin(schema.userAccount, eq(schema.userAccount.id, schema.movement.createdByUserId))
      .where(
        and(
          isNull(schema.movement.deletedAt),
          gte(schema.movement.businessDate, from),
          lte(schema.movement.businessDate, to),
        ),
      )
      .orderBy(schema.movement.businessDate, schema.movement.createdAt),
  );
  return list.map(({ phoneName, phoneE164, userEmail, createdAt: _c, ...r }) => ({
    ...r,
    author: phoneName ?? (phoneE164 ? `+${phoneE164}` : (userEmail ?? "")),
  }));
}

export { todayInCaracas };
