import { and, eq, lt, type Queryable, schema, type Tx } from "@caja/db";
import { z } from "zod";
import type { IsoDate } from "../domain/dates";
import {
  type Currency,
  convert,
  Decimal,
  money,
  type Rate,
  toDbAmount,
  toDbRate,
} from "../domain/money";
import { existingDayTotal, type PaymentMethod } from "./income";
import { rateFor } from "./rate-for";

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
  const { pendingId, replacedPrevious } = await insertDraft(
    tx,
    { tenantId: input.tenantId, phoneId: input.phoneId, kind: "create_expense", payload: draft },
    now,
  );
  return { pendingId, draft, replacedPrevious, usedPriorDayRate: usedPriorDay };
}

/** Un solo borrador activo por teléfono: cancela el anterior e inserta el nuevo. */
export async function insertDraft(
  tx: Tx,
  input: { tenantId: string; phoneId: string; kind: string; payload: unknown },
  now: Date,
): Promise<{ pendingId: string; replacedPrevious: boolean }> {
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
      kind: input.kind,
      payload: input.payload,
      expiresAt: new Date(now.getTime() + DRAFT_TTL_MS),
    })
    .returning({ id: schema.pendingAction.id });
  if (!row) throw new Error("no se pudo crear el borrador");
  return { pendingId: row.id, replacedPrevious: replaced.length > 0 };
}

// ---------------------------------------------------------------- ingresos (US-C1, C2, C3)

const Method = z.enum(schema.PAYMENT_METHODS);

export const IncomeLineDraft = z.object({
  method: Method,
  amount: z.string(),
  currency: z.enum(["USD", "VES"]),
  amountUsd: z.string(),
  amountVes: z.string(),
});
export type IncomeLineDraft = z.infer<typeof IncomeLineDraft>;

/**
 * Borrador de venta del día. `mismatch` queda cuando el desglose no cuadra con el total dicho:
 * los botones "Total X" resuelven la diferencia y el borrador se vuelve a mostrar. `existing`
 * indica que ya hay un total ese día: los botones pasan a Reemplazar / Agregar / Cancelar.
 */
export const IncomeDayTotalDraft = z.object({
  businessDate: z.string(),
  lines: z.array(IncomeLineDraft),
  totalUsd: z.string(),
  totalVes: z.string(),
  mismatch: z
    .object({
      statedUsd: z.string(),
      breakdownUsd: z.string(),
      statedCurrency: z.enum(["USD", "VES"]),
      statedAmount: z.string(),
    })
    .nullable(),
  existingUsd: z.string().nullable(),
  mode: z.enum(["replace", "append"]).nullable(),
  rateId: z.string().uuid(),
  rateValue: z.string(),
  rateEffectiveDate: z.string(),
  sourceChannel: z.enum(["text", "voice", "image"]),
  sourceMessageId: z.string().uuid().nullable(),
  transcript: z.string().nullable(),
  fixing: z.boolean().optional(),
});
export type IncomeDayTotalDraft = z.infer<typeof IncomeDayTotalDraft>;

export const IncomeSingleDraft = z.object({
  amount: z.string(),
  currency: z.enum(["USD", "VES"]),
  currencyInferred: z.boolean(),
  method: Method,
  description: z.string().nullable(),
  businessDate: z.string(),
  rateId: z.string().uuid(),
  rateValue: z.string(),
  rateEffectiveDate: z.string(),
  amountUsd: z.string(),
  amountVes: z.string(),
  sourceChannel: z.enum(["text", "voice", "image"]),
  sourceMessageId: z.string().uuid().nullable(),
  transcript: z.string().nullable(),
  fixing: z.boolean().optional(),
});
export type IncomeSingleDraft = z.infer<typeof IncomeSingleDraft>;

export type IncomeDayTotalInput = {
  tenantId: string;
  phoneId: string;
  businessDate: IsoDate;
  /** Total dicho por el usuario, si lo dijo. */
  stated: { amount: Decimal; currency: Currency } | null;
  lines: { method: PaymentMethod; amount: Decimal; currency: Currency }[];
  sourceChannel: "text" | "voice" | "image";
  sourceMessageId: string | null;
  transcript: string | null;
};

function toLine(l: IncomeDayTotalInput["lines"][number], rate: Rate): IncomeLineDraft {
  const c = convert(money(l.amount, l.currency), rate);
  return {
    method: l.method,
    amount: toDbAmount(c.amount),
    currency: c.currency,
    amountUsd: toDbAmount(c.amountUsd),
    amountVes: toDbAmount(c.amountVes),
  };
}

function sumLines(lines: IncomeLineDraft[]): { usd: Decimal; ves: Decimal } {
  return lines.reduce(
    (acc, l) => ({ usd: acc.usd.plus(l.amountUsd), ves: acc.ves.plus(l.amountVes) }),
    { usd: new Decimal(0), ves: new Decimal(0) },
  );
}

export async function createIncomeDayTotalDraft(
  tx: Tx,
  input: IncomeDayTotalInput,
  now: Date,
): Promise<{ pendingId: string; draft: IncomeDayTotalDraft; replacedPrevious: boolean }> {
  const { rate } = await rateFor(tx, input.businessDate);
  let lines = input.lines.map((l) => toLine(l, rate));
  let mismatch: IncomeDayTotalDraft["mismatch"] = null;
  if (input.stated) {
    const statedC = convert(money(input.stated.amount, input.stated.currency), rate);
    if (lines.length === 0) {
      lines = [
        toLine(
          { method: "unspecified", amount: input.stated.amount, currency: input.stated.currency },
          rate,
        ),
      ];
    } else {
      const breakdown = sumLines(lines).usd;
      if (breakdown.minus(statedC.amountUsd).abs().gt("0.01")) {
        mismatch = {
          statedUsd: toDbAmount(statedC.amountUsd),
          breakdownUsd: toDbAmount(breakdown),
          statedCurrency: input.stated.currency,
          statedAmount: toDbAmount(input.stated.amount),
        };
      }
    }
  }
  const totals = sumLines(lines);
  const existing = await existingDayTotal(tx, input.tenantId, input.businessDate);
  const draft: IncomeDayTotalDraft = {
    businessDate: input.businessDate,
    lines,
    totalUsd: toDbAmount(totals.usd),
    totalVes: toDbAmount(totals.ves),
    mismatch,
    existingUsd: existing.count > 0 ? toDbAmount(existing.usd) : null,
    mode: null,
    rateId: rate.id,
    rateValue: toDbRate(rate.value),
    rateEffectiveDate: rate.effectiveDate,
    sourceChannel: input.sourceChannel,
    sourceMessageId: input.sourceMessageId,
    transcript: input.transcript,
  };
  const { pendingId, replacedPrevious } = await insertDraft(
    tx,
    {
      tenantId: input.tenantId,
      phoneId: input.phoneId,
      kind: "create_income_day_total",
      payload: draft,
    },
    now,
  );
  return { pendingId, draft, replacedPrevious };
}

/**
 * Resuelve un desglose que no cuadra según lo que eligió el dueño: `stated` agrega la diferencia
 * como "Sin especificar"; `breakdown` deja el total en la suma del desglose.
 */
export function resolveMismatch(
  draft: IncomeDayTotalDraft,
  choice: "stated" | "breakdown",
): IncomeDayTotalDraft {
  if (!draft.mismatch) return draft;
  let lines = draft.lines;
  if (choice === "stated") {
    const rate = {
      value: new Decimal(draft.rateValue),
      effectiveDate: draft.rateEffectiveDate,
      id: draft.rateId,
    };
    const diffUsd = new Decimal(draft.mismatch.statedUsd).minus(draft.mismatch.breakdownUsd);
    if (diffUsd.gt(0)) {
      const amount =
        draft.mismatch.statedCurrency === "USD"
          ? diffUsd
          : diffUsd.mul(rate.value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      lines = [
        ...lines,
        toLine({ method: "unspecified", amount, currency: draft.mismatch.statedCurrency }, rate),
      ];
    }
  }
  const totals = sumLines(lines);
  return {
    ...draft,
    lines,
    totalUsd: toDbAmount(totals.usd),
    totalVes: toDbAmount(totals.ves),
    mismatch: null,
  };
}

export type IncomeSingleInput = {
  tenantId: string;
  phoneId: string;
  amount: Decimal;
  currency: Currency;
  currencyInferred: boolean;
  method: PaymentMethod;
  description: string | null;
  businessDate: IsoDate;
  sourceChannel: "text" | "voice" | "image";
  sourceMessageId: string | null;
  transcript: string | null;
};

export async function createIncomeSingleDraft(
  tx: Tx,
  input: IncomeSingleInput,
  now: Date,
): Promise<{ pendingId: string; draft: IncomeSingleDraft; replacedPrevious: boolean }> {
  const { rate } = await rateFor(tx, input.businessDate);
  const c = convert(money(input.amount, input.currency), rate);
  const draft: IncomeSingleDraft = {
    amount: toDbAmount(c.amount),
    currency: c.currency,
    currencyInferred: input.currencyInferred,
    method: input.method,
    description: input.description,
    businessDate: input.businessDate,
    rateId: rate.id,
    rateValue: toDbRate(rate.value),
    rateEffectiveDate: rate.effectiveDate,
    amountUsd: toDbAmount(c.amountUsd),
    amountVes: toDbAmount(c.amountVes),
    sourceChannel: input.sourceChannel,
    sourceMessageId: input.sourceMessageId,
    transcript: input.transcript,
  };
  const { pendingId, replacedPrevious } = await insertDraft(
    tx,
    {
      tenantId: input.tenantId,
      phoneId: input.phoneId,
      kind: "create_income_single",
      payload: draft,
    },
    now,
  );
  return { pendingId, draft, replacedPrevious };
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
