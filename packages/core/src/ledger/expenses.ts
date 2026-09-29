import { and, eq, isNull, rows, schema, sql, type Tx } from "@caja/db";
import { asIsoDate, type IsoDate } from "../domain/dates";
import {
  type Currency,
  convert,
  Decimal,
  rate as makeRate,
  money,
  toDbAmount,
  toDbRate,
} from "../domain/money";
import { rateFor } from "./rate-for";

/**
 * `LocalProvider` de gastos (ADR-009). Toda la aritmética ocurre aquí, dentro de una transacción
 * abierta con `withTenant`. Cada escritura deja su fila de auditoría en la misma transacción.
 */
export type Actor =
  | { phoneId: string; userId?: undefined }
  | { userId: string; phoneId?: undefined };

export type CreateExpenseInput = {
  tenantId: string;
  businessDate: IsoDate;
  amount: Decimal;
  currency: Currency;
  categoryId: string | null;
  description: string | null;
  sourceChannel: "text" | "voice" | "image" | "dashboard";
  actor: Actor;
  sourceMessageId?: string | null;
  attachmentId?: string | null;
  /** Tasa congelada en el borrador; si no viene, se resuelve la vigente para la fecha. */
  rate?: { id: string; value: string; effectiveDate: IsoDate };
};

export type CreatedExpense = {
  id: string;
  amountUsd: Decimal;
  amountVes: Decimal;
  rateValue: Decimal;
  rateEffectiveDate: IsoDate;
};

export async function createExpense(tx: Tx, input: CreateExpenseInput): Promise<CreatedExpense> {
  if (!input.amount.isFinite() || input.amount.lte(0)) throw new Error("monto inválido");
  const rate = input.rate
    ? makeRate(input.rate.value, input.rate.effectiveDate, input.rate.id)
    : (await rateFor(tx, input.businessDate)).rate;
  const c = convert(money(input.amount, input.currency), rate);
  const [row] = await tx
    .insert(schema.movement)
    .values({
      tenantId: input.tenantId,
      type: "expense",
      businessDate: input.businessDate,
      amount: toDbAmount(c.amount),
      currency: c.currency,
      rateId: rate.id,
      rateValue: toDbRate(c.rateValue),
      amountUsd: toDbAmount(c.amountUsd),
      amountVes: toDbAmount(c.amountVes),
      categoryId: input.categoryId,
      description: input.description,
      origin: "single",
      sourceChannel: input.sourceChannel,
      createdByPhoneId: input.actor.phoneId ?? null,
      createdByUserId: input.actor.userId ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
      attachmentId: input.attachmentId ?? null,
    })
    .returning();
  if (!row) throw new Error("no se pudo crear el gasto");
  await tx.insert(schema.auditLog).values({
    tenantId: input.tenantId,
    actorType: input.actor.phoneId ? "phone" : "user",
    actorId: input.actor.phoneId ?? input.actor.userId ?? null,
    action: "create",
    entity: "movement",
    entityId: row.id,
    before: null,
    after: row,
    channel: input.sourceChannel === "dashboard" ? "dashboard" : "whatsapp",
  });
  return {
    id: row.id,
    amountUsd: c.amountUsd,
    amountVes: c.amountVes,
    rateValue: c.rateValue,
    rateEffectiveDate: asIsoDate(rate.effectiveDate),
  };
}

/** Total de gastos vivos del día en USD (unidad de cuenta) y conteo. Todo en SQL. */
export async function expenseTotalForDay(
  tx: Tx,
  tenantId: string,
  businessDate: IsoDate,
): Promise<{ usd: Decimal; count: number }> {
  const found = rows<{ total: string | null; count: number | string }>(
    await tx.execute(sql`
      select coalesce(sum(amount_usd), 0)::text as total, count(*)::int as count
      from ${schema.movement}
      where tenant_id = ${tenantId} and type = 'expense' and business_date = ${businessDate}::date and deleted_at is null
    `),
  );
  const r = found[0];
  return { usd: new Decimal(r?.total ?? "0"), count: Number(r?.count ?? 0) };
}

/** Categoría activa por nombre exacto (sin distinguir mayúsculas ni acentos). */
export async function findCategory(tx: Tx, tenantId: string, name: string) {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const all = await tx
    .select()
    .from(schema.category)
    .where(
      and(
        eq(schema.category.tenantId, tenantId),
        eq(schema.category.kind, "expense"),
        eq(schema.category.isActive, true),
      ),
    );
  return all.find((c) => norm(c.name) === norm(name)) ?? null;
}

export { isNull };
