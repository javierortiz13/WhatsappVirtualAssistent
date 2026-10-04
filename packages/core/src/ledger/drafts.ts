import { and, desc, eq, inArray, lt, ne, type Queryable, schema, type Tx } from "@caja/db";
import { z } from "zod";
import type { IsoDate } from "../domain/dates";
import {
  type Currency,
  convert,
  Decimal,
  money,
  RATE_ORIGINS,
  type Rate,
  toDbAmount,
  toDbRate,
} from "../domain/money";
import { type AllocationPlan, planAllocation, planRate } from "./exchange";
import { existingDayTotal, type PaymentMethod } from "./income";
import { rateFor } from "./rate-for";

const ExchangeInfo = z.object({
  remainingAfter: z.string(),
  uncoveredVes: z.string(),
  lastRate: z.string(),
  /** De qué cambio sale cada parte (para el desglose cuando toma de dos o más). */
  parts: z.array(z.object({ ves: z.string(), rate: z.string(), usd: z.string() })).optional(),
});
export type ExchangeInfo = z.infer<typeof ExchangeInfo>;

const BsChoicePreview = z.object({
  exchangeUsd: z.string(),
  exchangeRate: z.string(),
  bcvUsd: z.string(),
  bcvRate: z.string(),
});
export type BsChoicePreview = z.infer<typeof BsChoicePreview>;

/**
 * Borradores de escritura (ADR-006). Una herramienta de escritura nunca toca `movement`: crea
 * una `pending_action` con el payload ya validado y convertido; el botón Guardar la ejecuta.
 * Pueden esperar varios por teléfono (cola, ver `insertDraft`); solo una corrección reemplaza a otro.
 */
export const ExpenseDraft = z.object({
  amount: z.string(),
  currency: z.enum(["USD", "VES"]),
  currencyInferred: z.boolean(),
  categoryId: z.string().uuid().nullable(),
  categoryName: z.string().nullable(),
  description: z.string().nullable(),
  businessDate: z.string(),
  rateId: z.string().uuid().nullable(),
  rateSource: z.enum(RATE_ORIGINS).default("bcv"),
  rateValue: z.string(),
  rateEffectiveDate: z.string(),
  amountUsd: z.string(),
  amountVes: z.string(),
  sourceChannel: z.enum(["text", "voice", "image"]),
  sourceMessageId: z.string().uuid().nullable(),
  attachmentId: z.string().uuid().nullable(),
  transcript: z.string().nullable(),
  fixing: z.boolean().optional(),
  /** De los lotes de cambio (0012): saldo después de este gasto y lo que no cubrieron. */
  exchange: ExchangeInfo.nullable().optional(),
  /** Modo "preguntar": los dos cálculos, para mostrar los botones Mi cambio USDT / Tasa BCV. */
  bsChoice: BsChoicePreview.nullable().optional(),
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
  /** Tasa dicha por el dueño al corregir (ADR-013); si viene, no se consulta bcv_rate. */
  manualRate?: Rate | null;
  /** Borrador pendiente que este corrige y reemplaza; sin esto, se suma a la cola. */
  replaces?: string | null;
  /**
   * Gastos en Bs con lotes de cambio (0012): "exchange" toma la tasa de los lotes; "ask" arma el
   * borrador a la BCV y guarda los dos cálculos para preguntar. Sin esto, la BCV de siempre.
   */
  bsRate?: "exchange" | "ask" | null;
};

/**
 * Convierte un gasto dicho por el usuario al payload del borrador, con la tasa del día (o la de los
 * lotes de cambio). `taken` lleva lo que ya tomaron de cada lote los renglones anteriores de un
 * mismo borrador, para que el siguiente no cuente esos Bs dos veces.
 */
async function buildExpenseDraft(
  tx: Tx,
  input: DraftInput,
  taken: Map<string, Decimal> = new Map(),
): Promise<{ draft: ExpenseDraft; usedPriorDay: boolean }> {
  const lots =
    input.currency === "VES" && !input.manualRate && input.bsRate
      ? await planAllocation(tx, input.tenantId, input.amount, { adjust: negate(taken) })
      : null;
  const useLots = lots && input.bsRate === "exchange";
  const { rate, usedPriorDay } = input.manualRate
    ? { rate: input.manualRate, usedPriorDay: false }
    : useLots
      ? { rate: planRate(lots, input.businessDate), usedPriorDay: false }
      : await rateFor(tx, input.businessDate);
  if (useLots)
    for (const p of lots.parts)
      taken.set(p.lotId, (taken.get(p.lotId) ?? new Decimal(0)).plus(p.ves));
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
    rateSource: rate.source,
    rateValue: toDbRate(c.rateValue),
    rateEffectiveDate: rate.effectiveDate,
    amountUsd: toDbAmount(c.amountUsd),
    amountVes: toDbAmount(c.amountVes),
    sourceChannel: input.sourceChannel,
    sourceMessageId: input.sourceMessageId,
    attachmentId: input.attachmentId,
    transcript: input.transcript,
    exchange: useLots ? exchangeInfo(lots) : null,
    bsChoice:
      lots && input.bsRate === "ask"
        ? {
            exchangeUsd: lots.usd.toFixed(2),
            exchangeRate: lots.rate.toFixed(8),
            bcvUsd: toDbAmount(c.amountUsd),
            bcvRate: toDbRate(c.rateValue),
          }
        : null,
  };
  return { draft, usedPriorDay };
}

function exchangeInfo(plan: AllocationPlan): ExchangeInfo {
  return {
    remainingAfter: plan.remainingAfter.toFixed(2),
    uncoveredVes: plan.uncoveredVes.toFixed(2),
    lastRate: plan.lastRate.toFixed(8),
    parts: plan.parts.map((p) => ({
      ves: p.ves.toFixed(2),
      rate: p.rate.toFixed(8),
      usd: p.ves.div(p.rate).toFixed(2),
    })),
  };
}

function negate(m: Map<string, Decimal>): Map<string, Decimal> {
  return new Map([...m].map(([k, v]) => [k, v.neg()]));
}

/**
 * Respuesta a "¿De dónde salieron estos Bs?" (modo preguntar): rehace los renglones en Bs del
 * borrador a la tasa de los lotes ("usdt") o a la BCV ("bcv") y quita la pregunta.
 */
export async function applyBsChoice(
  tx: Tx,
  tenantId: string,
  items: ExpenseDraft[],
  choice: "usdt" | "bcv",
): Promise<ExpenseDraft[]> {
  const taken = new Map<string, Decimal>();
  const out: ExpenseDraft[] = [];
  for (const item of items) {
    if (!item.bsChoice) {
      out.push(item);
      continue;
    }
    const businessDate = item.businessDate as IsoDate;
    const plan =
      choice === "usdt"
        ? await planAllocation(tx, tenantId, new Decimal(item.amount), { adjust: negate(taken) })
        : null;
    const rate = plan ? planRate(plan, businessDate) : (await rateFor(tx, businessDate)).rate;
    if (plan)
      for (const p of plan.parts)
        taken.set(p.lotId, (taken.get(p.lotId) ?? new Decimal(0)).plus(p.ves));
    const c = convert(money(new Decimal(item.amount), "VES"), rate);
    out.push({
      ...item,
      rateId: rate.id,
      rateSource: rate.source,
      rateValue: toDbRate(c.rateValue),
      rateEffectiveDate: rate.effectiveDate,
      amountUsd: toDbAmount(c.amountUsd),
      amountVes: toDbAmount(c.amountVes),
      exchange: plan ? exchangeInfo(plan) : null,
      bsChoice: null,
    });
  }
  return out;
}

/** El borrador espera la respuesta a "¿De dónde salieron estos Bs?". */
export function awaitsBsChoice(items: ExpenseDraft[]): boolean {
  return items.some((i) => i.bsChoice);
}

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
  const { draft, usedPriorDay } = await buildExpenseDraft(tx, input);
  const { pendingId, replacedPrevious } = await insertDraft(
    tx,
    {
      tenantId: input.tenantId,
      phoneId: input.phoneId,
      kind: "create_expense",
      payload: draft,
      replaces: input.replaces ?? null,
    },
    now,
  );
  return { pendingId, draft, replacedPrevious, usedPriorDayRate: usedPriorDay };
}

/**
 * Varios gastos en un solo mensaje ("7$ en una arepa y 7,5$ en pádel"): un único borrador con la
 * lista; Guardar escribe un movimiento por renglón. Cada renglón lleva su propia tasa y fecha.
 */
export const ExpensesDraft = z.object({
  items: z.array(ExpenseDraft).min(1),
  fixing: z.boolean().optional(),
});
export type ExpensesDraft = z.infer<typeof ExpensesDraft>;

export async function createExpensesDraft(
  tx: Tx,
  inputs: DraftInput[],
  now: Date,
): Promise<{
  pendingId: string;
  draft: ExpensesDraft;
  replacedPrevious: boolean;
  usedPriorDayRate: boolean;
}> {
  const first = inputs[0];
  if (!first) throw new Error("un borrador múltiple necesita al menos un gasto");
  const items: ExpenseDraft[] = [];
  let usedPriorDayRate = false;
  const taken = new Map<string, Decimal>();
  for (const input of inputs) {
    const { draft, usedPriorDay } = await buildExpenseDraft(tx, input, taken);
    items.push(draft);
    usedPriorDayRate ||= usedPriorDay;
  }
  const draft: ExpensesDraft = { items };
  const { pendingId, replacedPrevious } = await insertDraft(
    tx,
    {
      tenantId: first.tenantId,
      phoneId: first.phoneId,
      kind: "create_expenses",
      payload: draft,
      replaces: first.replaces ?? null,
    },
    now,
  );
  return { pendingId, draft, replacedPrevious, usedPriorDayRate };
}

/** Borradores que pueden esperar confirmación a la vez en un mismo teléfono. */
export const MAX_PENDING_PER_PHONE = 5;

/**
 * Cola de borradores: cada borrador nuevo se suma a los pendientes del teléfono y tiene sus
 * propios botones. Solo reemplaza a otro cuando es una corrección (`replaces`). Si la cola pasa
 * del tope, los más viejos se cancelan.
 */
export async function insertDraft(
  tx: Tx,
  input: {
    tenantId: string;
    phoneId: string;
    kind: string;
    payload: unknown;
    replaces?: string | null;
  },
  now: Date,
): Promise<{ pendingId: string; replacedPrevious: boolean }> {
  const replaced = input.replaces
    ? await tx
        .update(schema.pendingAction)
        .set({ status: "cancelled", resolvedAt: now })
        .where(
          and(
            eq(schema.pendingAction.id, input.replaces),
            eq(schema.pendingAction.phoneId, input.phoneId),
            eq(schema.pendingAction.status, "pending"),
          ),
        )
        .returning({ id: schema.pendingAction.id })
    : [];
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
  const queue = await pendingDrafts(tx, input.phoneId);
  const overflow = queue.slice(MAX_PENDING_PER_PHONE).filter((d) => d.id !== row.id);
  if (overflow.length)
    await tx
      .update(schema.pendingAction)
      .set({ status: "cancelled", resolvedAt: now })
      .where(
        inArray(
          schema.pendingAction.id,
          overflow.map((d) => d.id),
        ),
      );
  return { pendingId: row.id, replacedPrevious: replaced.length > 0 };
}

/** Borradores pendientes del teléfono, el más reciente primero. */
/** Borradores en espera del teléfono. La intención de renovar el plan no es un borrador. */
export async function pendingDrafts(tx: Tx, phoneId: string) {
  return tx
    .select()
    .from(schema.pendingAction)
    .where(
      and(
        eq(schema.pendingAction.phoneId, phoneId),
        eq(schema.pendingAction.status, "pending"),
        ne(schema.pendingAction.kind, "renew_plan"),
      ),
    )
    .orderBy(desc(schema.pendingAction.createdAt), desc(schema.pendingAction.expiresAt));
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
  rateId: z.string().uuid().nullable(),
  rateSource: z.enum(RATE_ORIGINS).default("bcv"),
  rateValue: z.string(),
  rateEffectiveDate: z.string(),
  sourceChannel: z.enum(["text", "voice", "image"]),
  sourceMessageId: z.string().uuid().nullable(),
  /** Reporte de ventas en foto o PDF (03/10); los borradores viejos no lo traen. */
  attachmentId: z.string().uuid().nullable().default(null),
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
  rateId: z.string().uuid().nullable(),
  rateSource: z.enum(RATE_ORIGINS).default("bcv"),
  rateValue: z.string(),
  rateEffectiveDate: z.string(),
  amountUsd: z.string(),
  amountVes: z.string(),
  sourceChannel: z.enum(["text", "voice", "image"]),
  sourceMessageId: z.string().uuid().nullable(),
  attachmentId: z.string().uuid().nullable().default(null),
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
  attachmentId?: string | null;
  transcript: string | null;
  manualRate?: Rate | null;
  replaces?: string | null;
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
  const { rate } = input.manualRate
    ? { rate: input.manualRate }
    : await rateFor(tx, input.businessDate);
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
    rateSource: rate.source,
    rateValue: toDbRate(rate.value),
    rateEffectiveDate: rate.effectiveDate,
    sourceChannel: input.sourceChannel,
    sourceMessageId: input.sourceMessageId,
    attachmentId: input.attachmentId ?? null,
    transcript: input.transcript,
  };
  const { pendingId, replacedPrevious } = await insertDraft(
    tx,
    {
      tenantId: input.tenantId,
      phoneId: input.phoneId,
      kind: "create_income_day_total",
      payload: draft,
      replaces: input.replaces ?? null,
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
    const rate: Rate = {
      value: new Decimal(draft.rateValue),
      effectiveDate: draft.rateEffectiveDate,
      id: draft.rateId,
      source: draft.rateSource,
    };
    const diffUsd = new Decimal(draft.mismatch.statedUsd).minus(draft.mismatch.breakdownUsd);
    if (diffUsd.gt(0)) {
      // Total dicho en Bs: la diferencia se saca en Bs (pasar por $ y volver dejaba céntimos de
      // menos: Bs 10.000 terminaba en 9.999,82).
      const linesVes = lines.reduce((acc, l) => acc.plus(l.amountVes), new Decimal(0));
      const amount =
        draft.mismatch.statedCurrency === "USD"
          ? diffUsd
          : new Decimal(draft.mismatch.statedAmount).minus(linesVes);
      if (amount.gt(0))
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
  attachmentId?: string | null;
  transcript: string | null;
  manualRate?: Rate | null;
  replaces?: string | null;
};

export async function createIncomeSingleDraft(
  tx: Tx,
  input: IncomeSingleInput,
  now: Date,
): Promise<{ pendingId: string; draft: IncomeSingleDraft; replacedPrevious: boolean }> {
  const { rate } = input.manualRate
    ? { rate: input.manualRate }
    : await rateFor(tx, input.businessDate);
  const c = convert(money(input.amount, input.currency), rate);
  const draft: IncomeSingleDraft = {
    amount: toDbAmount(c.amount),
    currency: c.currency,
    currencyInferred: input.currencyInferred,
    method: input.method,
    description: input.description,
    businessDate: input.businessDate,
    rateId: rate.id,
    rateSource: rate.source,
    rateValue: toDbRate(rate.value),
    rateEffectiveDate: rate.effectiveDate,
    amountUsd: toDbAmount(c.amountUsd),
    amountVes: toDbAmount(c.amountVes),
    sourceChannel: input.sourceChannel,
    sourceMessageId: input.sourceMessageId,
    attachmentId: input.attachmentId ?? null,
    transcript: input.transcript,
  };
  const { pendingId, replacedPrevious } = await insertDraft(
    tx,
    {
      tenantId: input.tenantId,
      phoneId: input.phoneId,
      kind: "create_income_single",
      payload: draft,
      replaces: input.replaces ?? null,
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
