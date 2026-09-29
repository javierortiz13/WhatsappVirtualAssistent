import { and, eq, lt, type Queryable, schema, type Tx } from "@caja/db";
import { z } from "zod";
import type { IsoDate } from "../domain/dates.js";
import { type Currency, convert, Decimal, money, toDbAmount, toDbRate } from "../domain/money.js";
import { rateFor } from "./rate-for.js";

/**
 * Borradores de escritura (ADR-006). Una herramienta de escritura nunca toca `movement`: crea
 * una `pending_action` con el payload ya validado y convertido; el botón Guardar la ejecuta.
 * Solo hay un borrador activo por teléfono: uno nuevo reemplaza al anterior, con aviso.
 */
export const ExpenseDraft = z.object({
  amount: z.string(),
  currency: z.enum(["USD", "VES"]),
  currencyInferred: z.boolean(),
  categoryId: z.string().uuid().nullable(),
  categoryName: z.string().nullable(),
  description: z.string().nullable(),
  businessDate: z.string(),
  rateId: z.string().uuid(),
  rateValue: z.string(),
  rateEffectiveDate: z.string(),
  amountUsd: z.string(),
  amountVes: z.string(),
  sourceChannel: z.enum(["text", "voice", "image"]),
  sourceMessageId: z.string().uuid().nullable(),
  attachmentId: z.string().uuid().nullable(),
  transcript: z.string().nullable(),
  fixing: z.boolean().optional(),
});
export type ExpenseDraft = z.infer<typeof ExpenseDraft>;

export const DRAFT_TTL_MS = 10 * 60 * 1000;

export type DraftInput = {
  tenantId: string;
  phoneId: string;
  amount: Decimal;
  currency: Currency;
  currencyInferred: boolean;
  categoryId: string | null;
  categoryName: string | null;
  description: string | null;
  businessDate: IsoDate;
  sourceChannel: "text" | "voice" | "image";
  sourceMessageId: string | null;
  attachmentId: string | null;
  transcript: string | null;
};

export async function createExpenseDraft(
  tx: Tx,
  input: DraftInput,
  now: Date,
): Promise<{
  pendingId: string;
  draft: ExpenseDraft;
  replacedPrevious: boolean;
  usedPriorDayRate: boolean;
}> {
  const { rate, usedPriorDay } = await rateFor(tx, input.businessDate);
  const c = convert(money(input.amount, input.currency), rate);
  const draft: ExpenseDraft = {
    amount: toDbAmount(c.amount),
    currency: c.currency,
    currencyInferred: input.currencyInferred,
    categoryId: input.categoryId,
    categoryName: input.categoryName,
    description: input.description,
    businessDate: input.businessDate,
    rateId: rate.id,
    rateValue: toDbRate(c.rateValue),
    rateEffectiveDate: rate.effectiveDate,
    amountUsd: toDbAmount(c.amountUsd),
    amountVes: toDbAmount(c.amountVes),
    sourceChannel: input.sourceChannel,
    sourceMessageId: input.sourceMessageId,
    attachmentId: input.attachmentId,
    transcript: input.transcript,
  };
  const replaced = await tx
    .update(schema.pendingAction)
    .set({ status: "cancelled", resolvedAt: now })
    .where(
      and(
        eq(schema.pendingAction.phoneId, input.phoneId),
        eq(schema.pendingAction.status, "pending"),
      ),
    )
    .returning({ id: schema.pendingAction.id });
  const [row] = await tx
    .insert(schema.pendingAction)
    .values({
      tenantId: input.tenantId,
      phoneId: input.phoneId,
      kind: "create_expense",
      payload: draft,
      expiresAt: new Date(now.getTime() + DRAFT_TTL_MS),
    })
    .returning({ id: schema.pendingAction.id });
  if (!row) throw new Error("no se pudo crear el borrador");
  return {
    pendingId: row.id,
    draft,
    replacedPrevious: replaced.length > 0,
    usedPriorDayRate: usedPriorDay,
  };
}

/** Job de limpieza: borradores vencidos pasan a `expired`. Corre entre tenants con el rol adecuado. */
export async function expirePendingActions(db: Queryable, now: Date): Promise<number> {
  const rows = await db
    .update(schema.pendingAction)
    .set({ status: "expired", resolvedAt: now })
    .where(and(eq(schema.pendingAction.status, "pending"), lt(schema.pendingAction.expiresAt, now)))
    .returning({ id: schema.pendingAction.id });
  return rows.length;
}

export { Decimal };
