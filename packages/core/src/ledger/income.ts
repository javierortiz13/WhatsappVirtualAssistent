import { and, eq, isNull, rows, schema, sql, type Tx } from "@caja/db";
import { asIsoDate, type IsoDate } from "../domain/dates";
import {
  type Currency,
  convert,
  Decimal,
  rate as makeRate,
  money,
  type Rate,
  type RateOrigin,
  toDbAmount,
  toDbRate,
} from "../domain/money";
import type { Actor } from "./expenses";
import { rateFor } from "./rate-for";

/**
 * Ingresos (US-C1, US-C2, US-C3). Igual que los gastos: toda la aritmética aquí, dentro de la
 * transacción del tenant, con auditoría por fila. El total del día es N movimientos con
 * `origin = day_total` (uno por método); el ingreso suelto es `origin = single`.
 */
export type PaymentMethod = (typeof schema.PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash_usd: "Efectivo USD",
  cash_ves: "Efectivo Bs",
  pago_movil: "Pago Móvil",
  punto: "Punto",
  zelle: "Zelle",
  transfer_usd: "Transferencia USD",
  transfer_ves: "Transferencia Bs",
  other: "Otro",
  unspecified: "Sin especificar",
};

export type IncomeLine = { method: PaymentMethod; amount: Decimal; currency: Currency };

type Common = {
  tenantId: string;
  businessDate: IsoDate;
  actor: Actor;
  sourceChannel: "text" | "voice" | "image" | "dashboard";
  sourceMessageId?: string | null;
  rate?: { id: string | null; value: string; effectiveDate: IsoDate; source?: RateOrigin };
};

async function resolveRate(tx: Tx, input: Common): Promise<Rate> {
  return input.rate
    ? makeRate(
        input.rate.value,
        input.rate.effectiveDate,
        input.rate.id,
        input.rate.source ?? "bcv",
      )
    : (await rateFor(tx, input.businessDate)).rate;
}

async function insertIncome(
  tx: Tx,
  input: Common,
  line: IncomeLine,
  origin: "single" | "day_total",
  description: string | null,
  rate: Rate,
) {
  if (!line.amount.isFinite() || line.amount.lte(0)) throw new Error("monto inválido");
  const c = convert(money(line.amount, line.currency), rate);
  const [row] = await tx
    .insert(schema.movement)
    .values({
      tenantId: input.tenantId,
      type: "income",
      businessDate: input.businessDate,
      amount: toDbAmount(c.amount),
      currency: c.currency,
      rateId: rate.id,
      rateSource: rate.source,
      rateValue: toDbRate(c.rateValue),
      amountUsd: toDbAmount(c.amountUsd),
      amountVes: toDbAmount(c.amountVes),
      categoryId: null,
      paymentMethod: line.method,
      description,
      origin,
      sourceChannel: input.sourceChannel,
      createdByPhoneId: input.actor.phoneId ?? null,
      createdByUserId: input.actor.userId ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
    })
    .returning();
  if (!row) throw new Error("no se pudo crear el ingreso");
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
  return { id: row.id, amountUsd: c.amountUsd, amountVes: c.amountVes };
}

export type CreatedIncome = {
  ids: string[];
  totalUsd: Decimal;
  totalVes: Decimal;
  replaced: number;
  rateEffectiveDate: IsoDate;
};

/** Total del día: una fila por método. `replace` da de baja lógica los `day_total` previos de esa fecha. */
export async function createIncomeDayTotal(
  tx: Tx,
  input: Common & { lines: IncomeLine[]; replace: boolean },
): Promise<CreatedIncome> {
  if (input.lines.length === 0) throw new Error("sin líneas");
  const rate = await resolveRate(tx, input);
  let replaced = 0;
  if (input.replace) replaced = await softDeleteDayTotal(tx, input);
  const ids: string[] = [];
  let totalUsd = new Decimal(0);
  let totalVes = new Decimal(0);
  for (const line of input.lines) {
    const r = await insertIncome(tx, input, line, "day_total", null, rate);
    ids.push(r.id);
    totalUsd = totalUsd.plus(r.amountUsd);
    totalVes = totalVes.plus(r.amountVes);
  }
  return { ids, totalUsd, totalVes, replaced, rateEffectiveDate: asIsoDate(rate.effectiveDate) };
}

export async function createIncomeSingle(
  tx: Tx,
  input: Common & { line: IncomeLine; description: string | null },
): Promise<CreatedIncome> {
  const rate = await resolveRate(tx, input);
  const r = await insertIncome(tx, input, input.line, "single", input.description, rate);
  return {
    ids: [r.id],
    totalUsd: r.amountUsd,
    totalVes: r.amountVes,
    replaced: 0,
    rateEffectiveDate: asIsoDate(rate.effectiveDate),
  };
}

async function softDeleteDayTotal(tx: Tx, input: Common): Promise<number> {
  const previous = await tx
    .select()
    .from(schema.movement)
    .where(
      and(
        eq(schema.movement.tenantId, input.tenantId),
        eq(schema.movement.type, "income"),
        eq(schema.movement.origin, "day_total"),
        eq(schema.movement.businessDate, input.businessDate),
        isNull(schema.movement.deletedAt),
      ),
    );
  const now = new Date();
  for (const m of previous) {
    await tx
      .update(schema.movement)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(schema.movement.id, m.id));
    await tx.insert(schema.auditLog).values({
      tenantId: input.tenantId,
      actorType: input.actor.phoneId ? "phone" : "user",
      actorId: input.actor.phoneId ?? input.actor.userId ?? null,
      action: "delete",
      entity: "movement",
      entityId: m.id,
      before: m,
      after: { ...m, deletedAt: now },
      channel: input.sourceChannel === "dashboard" ? "dashboard" : "whatsapp",
    });
  }
  return previous.length;
}

/** Total del día ya registrado (solo `day_total` vivos), para US-C3. */
export async function existingDayTotal(
  tx: Tx,
  tenantId: string,
  businessDate: IsoDate,
): Promise<{ count: number; usd: Decimal }> {
  const found = rows<{ total: string | null; count: number | string }>(
    await tx.execute(sql`
      select coalesce(sum(amount_usd), 0)::text as total, count(*) as count
      from ${schema.movement}
      where tenant_id = ${tenantId} and type = 'income' and origin = 'day_total'
        and business_date = ${businessDate}::date and deleted_at is null
    `),
  );
  return { count: Number(found[0]?.count ?? 0), usd: new Decimal(found[0]?.total ?? 0) };
}

/** Ventas y gastos vivos del día en USD, para el mensaje de guardado y el cierre. */
export async function dayTotals(
  tx: Tx,
  tenantId: string,
  businessDate: IsoDate,
): Promise<{ salesUsd: Decimal; expensesUsd: Decimal; count: number }> {
  const found = rows<{ sales: string | null; expenses: string | null; count: number | string }>(
    await tx.execute(sql`
      select coalesce(sum(amount_usd) filter (where type = 'income'), 0)::text as sales,
             coalesce(sum(amount_usd) filter (where type = 'expense'), 0)::text as expenses,
             count(*) as count
      from ${schema.movement}
      where tenant_id = ${tenantId} and business_date = ${businessDate}::date and deleted_at is null
    `),
  );
  return {
    salesUsd: new Decimal(found[0]?.sales ?? 0),
    expensesUsd: new Decimal(found[0]?.expenses ?? 0),
    count: Number(found[0]?.count ?? 0),
  };
}
