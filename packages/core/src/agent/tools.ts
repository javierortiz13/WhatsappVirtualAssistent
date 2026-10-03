import { eq, schema, type Tx } from "@caja/db";
import { z } from "zod";
import { planFromName } from "../billing/renew";
import { renewOfferReply, renewPayToReply, renewReferenceReply } from "../billing/renew-chat";
import { inferCurrency } from "../domain/currency-rule";
import {
  addDays,
  daysBetween,
  type IsoDate,
  isIsoDate,
  resolveRelativeDate,
} from "../domain/dates";
import {
  Decimal,
  formatMoney,
  isPositiveAmount,
  manualRate,
  parseVenezuelanAmount,
  type Rate,
} from "../domain/money";
import { budgetStatuses } from "../ledger/budgets";
import {
  createExpenseDraft,
  createExpensesDraft,
  createIncomeDayTotalDraft,
  createIncomeSingleDraft,
  type DraftInput,
} from "../ledger/drafts";
import { findCategory } from "../ledger/expenses";
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from "../ledger/income";
import {
  type AmendChanges,
  createDeleteLastDraft,
  createDeleteManyDraft,
  createEditLastDraft,
  DELETE_MANY_MAX,
  isTooOld,
  lastMovementByPhone,
  type Movement,
  recentMovementsByPhone,
} from "../ledger/last-movement";
import {
  rateFor as bcvRateFor,
  euroRateFor,
  NoEurRateError,
  NoRateError,
} from "../ledger/rate-for";
import { matchCategoryName } from "../ledger/reports";
import { renderSummary } from "../ledger/summary";
import { getRateInfo } from "../rates/current";
import { es, type Outbound } from "../render/index";
import type { LlmToolDef } from "./llm";
import type { AgentContext } from "./types";

/**
 * Herramientas del agente (Fase 3). Cada una tiene esquema Zod (validación en backend), su JSON
 * Schema para el modelo, y un ejecutor que corre dentro de la transacción del tenant. Las de
 * escritura crean un borrador; nunca escriben en `movement`. Los roles filtran qué se expone.
 */
export type ToolRunCtx = {
  tx: Tx;
  ctx: AgentContext;
  /** Texto del usuario en este turno. */
  userText: string;
  /** Este turno más los mensajes anteriores del usuario: las cifras de una aclaración salen de aquí. */
  groundingText?: string;
  now: Date;
  /**
   * Cola de borradores del teléfono: el que está en corrección (botón Corregir) y el más reciente.
   * Un borrador nuevo solo reemplaza a uno de estos cuando es una corrección, y hereda su foto.
   */
  drafts: { fixing: DraftRef | null; latest: DraftRef | null };
};

export type DraftRef = { id: string; kind: string; payload: Record<string, unknown> };

/** El borrador que corrige esta llamada: el que está en corrección, o el más reciente si el modelo lo indica. */
export function draftTarget(run: ToolRunCtx, corrects: boolean): DraftRef | null {
  return run.drafts.fixing ?? (corrects ? run.drafts.latest : null);
}

export type ToolOutcome =
  | { kind: "terminal"; outbound: Outbound[]; status: "ok" | "rejected_out_of_scope" }
  | { kind: "continue"; resultForModel: string };

export type ToolSpec<S extends z.ZodType> = {
  name: string;
  description: string;
  schema: S;
  roles: ("owner" | "employee")[];
  run: (input: z.infer<S>, run: ToolRunCtx) => Promise<ToolOutcome>;
};

/**
 * El modo `strict` admite como máximo 16 parámetros con tipo unión en todo el conjunto de
 * herramientas, y cada `nullable` cuenta. Por eso "no lo dijo" se expresa con "" en los textos
 * y con `unknown` / `keep` / `unspecified` en las listas, nunca con null. El backend normaliza
 * con `nz` y `cur`.
 */
const CurrencyOrUnknown = z.enum(["USD", "VES", "EUR", "unknown"]);
const nz = (s: string): string | null => (s.trim() ? s.trim() : null);
const cur = (c: "USD" | "VES" | "EUR" | "unknown" | "keep"): "USD" | "VES" | null =>
  c === "USD" || c === "VES" ? c : null;

const RATE_FIELD = z
  .string()
  .describe(
    'Tasa SOLO si el usuario la dice explícitamente. Un número ("a tasa 850", "tasa 857,89") normalizado a dígitos con punto, o "euro" si pide la tasa euro del BCV ("a tasa euro", "a la tasa del euro", "tasa €", "al euro del día"). "" si no la dijo.',
  );

const CORRECTS_FIELD = z
  .boolean()
  .describe(
    "true SOLO si el mensaje corrige el borrador SIN GUARDAR más reciente ('no, eran 50', 'era en bolívares', 'es de ayer') en vez de registrar algo nuevo. false si es un registro nuevo, aunque haya otros borradores esperando.",
  );

export const DraftExpenseInput = z.object({
  amount: z
    .string()
    .describe(
      'Monto tal como lo dijo el usuario, normalizado a dígitos con punto decimal. "15,50" → "15.50"; "450 mil" → "450000"; "medio millón" → "500000".',
    ),
  currency: CurrencyOrUnknown.describe(
    "USD si dijo $, dólares, verdes, usd. VES si dijo bs, bolos, bolívares. EUR si el monto está en euros (€, euros). unknown si no lo dijo.",
  ),
  description: z
    .string()
    .max(120)
    .describe(
      "Qué se compró o pagó, en 1 a 5 palabras, sin el monto. Ej: 'Champú', 'Gasolina', 'Comida del personal'.",
    ),
  category_name: z
    .string()
    .describe(
      'Una categoría de la lista del negocio, copiada exactamente, o "" si ninguna encaja claramente.',
    ),
  when: z
    .string()
    .describe(
      'Cuándo fue: "hoy", "ayer", "antier", un día de la semana ("lunes"), o una fecha ISO YYYY-MM-DD. "" si no lo dijo (se asume hoy).',
    ),
  rate: RATE_FIELD,
  corrects_draft: CORRECTS_FIELD,
});

/**
 * Varios gastos en un mensaje: la misma forma que draft_expense, por renglón, con una sola tasa
 * manual para todos. Sin `nullable` para no gastar uniones del modo estricto.
 */
const ExpenseItem = z.object({
  amount: DraftExpenseInput.shape.amount,
  currency: DraftExpenseInput.shape.currency,
  description: DraftExpenseInput.shape.description,
  category_name: DraftExpenseInput.shape.category_name,
  when: DraftExpenseInput.shape.when,
});

export const DraftExpensesInput = z.object({
  items: z
    .array(ExpenseItem)
    .min(2)
    .max(6)
    .describe(
      "Un elemento por gasto, en el orden en que los dijo el usuario. Cada uno con su monto y su descripción.",
    ),
  rate: RATE_FIELD,
  corrects_draft: CORRECTS_FIELD,
});

export const AskClarificationInput = z.object({
  question: z
    .string()
    .max(300)
    .describe(
      "Una sola pregunta corta en español venezolano, tuteo. No inventes cifras que el usuario no dijo.",
    ),
  options: z
    .array(z.string().max(20))
    .max(3)
    .describe("Hasta 3 opciones cortas si aplica; lista vacía si es pregunta abierta."),
});

export const RejectOutOfScopeInput = z.object({
  reason: z
    .enum(["general_chat", "other_business_task", "unclear"])
    .describe("Por qué no aplica ninguna función."),
});

export const GetBcvRateInput = z.object({});

const Method = z.enum([
  "cash_usd",
  "cash_ves",
  "pago_movil",
  "punto",
  "zelle",
  "transfer_usd",
  "transfer_ves",
  "other",
]);

export const AmendLastInput = z.object({
  amount: z.string().describe('Nuevo monto normalizado, o "" si no cambia.'),
  currency: z.enum(["USD", "VES", "keep"]).describe("Nueva moneda si la dijo; keep si no cambia."),
  category_name: z.string().describe('Nueva categoría de la lista, o "" si no cambia.'),
  description: z.string().max(120).describe('Nueva descripción, o "" si no cambia.'),
  when: z.string().describe('Nueva fecha (hoy, ayer, día de la semana, ISO), o "" si no cambia.'),
  method: z
    .enum([...Method.options, "keep"])
    .describe("Nuevo método de pago (solo ventas), o keep si no cambia."),
  rate: z.string().describe('Nueva tasa Bs por dólar si la dice explícitamente, o "".'),
});

export const DeleteLastInput = z.object({
  scope: z
    .enum(["last", "last_batch", "last_n", "matching"])
    .describe(
      "last: solo el último ('bórralo', 'quita eso'). last_batch: los que se guardaron juntos con el último Guardar, como un borrador de varios gastos ('bórralos', 'elimina esos gastos', 'borra lo que acabo de guardar'). last_n: los N últimos cuando dice cuántos ('borra los 3 últimos', 'elimina esos dos gastos') o cuando los guardó con varios Guardar. matching: los que coinciden con lo que nombra ('borra el de la arepa').",
    ),
  count: z
    .number()
    .int()
    .describe("Solo con last_n: cuántos movimientos (2 a 10). 0 con los demás scopes."),
  description: z
    .string()
    .describe(
      "Solo con matching: qué se compró o vendió, en 1 a 3 palabras ('arepa', 'pádel'). \"\" con los demás scopes.",
    ),
});
export type DeleteLastInput = z.infer<typeof DeleteLastInput>;

export const DraftIncomeDayTotalInput = z.object({
  total_amount: z
    .string()
    .describe(
      'Total de la venta del día tal como lo dijo, normalizado a dígitos con punto decimal ("350", "1.200,50" → "1200.50"). "" si solo dio el desglose sin total.',
    ),
  total_currency: CurrencyOrUnknown.describe("Moneda del total si la dijo; unknown si no."),
  lines: z
    .array(
      z.object({
        method: Method.describe(
          "efectivo/cash en dólares = cash_usd; efectivo en bs = cash_ves; pago móvil/pm = pago_movil; punto/pdv = punto; zelle = zelle; transferencia en dólares = transfer_usd; transferencia en bs = transfer_ves; otro = other. Si dice solo 'efectivo' sin moneda y el total es en dólares, cash_usd.",
        ),
        amount: z.string().describe("Monto de ese método, normalizado igual que total_amount."),
        currency: CurrencyOrUnknown.describe("Moneda si la dijo para ese método; unknown si no."),
      }),
    )
    .describe("Desglose por método de pago. Lista vacía si solo dijo el total."),
  when: z
    .string()
    .describe('"hoy", "ayer", "antier", un día de la semana o fecha ISO. "" si no lo dijo.'),
  rate: RATE_FIELD,
  corrects_draft: CORRECTS_FIELD,
});

export const GetSummaryInput = z.object({
  period: z
    .enum(["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "custom"])
    .describe(
      '"today" para "cierre", "cómo fue hoy"; "this_month" para "cómo va el mes", "cuánto llevo"; "custom" con from/to para "del 1 al 15", "en agosto".',
    ),
  from: z.string().describe('Fecha ISO de inicio si period es custom; "" si no.'),
  to: z.string().describe('Fecha ISO de fin si period es custom; "" si no.'),
  category_name: z
    .string()
    .describe(
      'Solo si pregunta cuánto gastó en UNA categoría o cosa ("en champú", "en insumos"): el nombre de la lista o lo que dijo. "" para el cierre o resumen general.',
    ),
});

export const GetBudgetsInput = z.object({
  category_name: z
    .string()
    .describe(
      'La categoría si pregunta por UNA ("cuánto me queda en insumos"): el nombre de la lista o lo que dijo. "" para todos los presupuestos.',
    ),
  wants_to_set: z
    .boolean()
    .describe(
      'true si quiere PONER, cambiar o quitar un presupuesto ("ponle 200$ al mes a insumos"); false si solo pregunta cómo va.',
    ),
});

export const RenewPlanInput = z.object({
  plan: z
    .enum(["current", "personal", "negocio", "negocio_plus"])
    .describe(
      'Plan a pagar: "current" si no pidió cambiarse; "personal", "negocio" o "negocio_plus" si dijo "pásame a ...".',
    ),
  months: z.number().int().describe("Meses a pagar; 1 si no lo dijo (máximo 12)."),
  method: z
    .enum(["unknown", "pago_movil", "zelle", "binance"])
    .describe("Cómo va a pagar o pagó, si lo dijo; unknown si no."),
  reference: z
    .string()
    .describe(
      'Referencia o número de confirmación del pago si lo dio ("ref 123456" → "123456"); "" si no.',
    ),
});

export const DraftIncomeSingleInput = z.object({
  amount: z.string().describe("Monto normalizado a dígitos con punto decimal."),
  currency: CurrencyOrUnknown.describe("USD, VES o unknown si no la dijo."),
  method: z
    .enum([...Method.options, "unspecified"])
    .describe("Método de pago si lo dijo (zelle, pago móvil, efectivo...); unspecified si no."),
  description: z
    .string()
    .max(120)
    .describe("Por qué le pagaron, en 1 a 6 palabras, sin el monto. Ej: 'Carro del abogado'."),
  when: z.string().describe('"hoy", "ayer", día de la semana o fecha ISO. "" si no lo dijo.'),
  rate: RATE_FIELD,
  corrects_draft: CORRECTS_FIELD,
});

export function defaultCategoryId(categories: AgentContext["categories"]): string | null {
  return categories.find((c) => c.name.toLowerCase() === "otros")?.id ?? categories[0]?.id ?? null;
}

function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Coincidencia exacta o por solapamiento de palabras con la lista del tenant. */
export function matchCategory(categories: AgentContext["categories"], name: string | null) {
  if (!name) return null;
  const n = norm(name);
  const exact = categories.find((c) => norm(c.name) === n);
  if (exact) return exact;
  const words = new Set(
    n.split(/\s+/).filter((w) => w.length > 2 && !["de", "del", "los", "las"].includes(w)),
  );
  let best: { c: AgentContext["categories"][number]; score: number } | null = null;
  for (const c of categories) {
    const cw = norm(c.name).split(/\s+/);
    const score = cw.filter((w) => words.has(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { c, score };
  }
  return best?.c ?? null;
}

export function resolveWhen(
  when: string | null,
  today: IsoDate,
): { date: IsoDate } | { error: "unknown" | "future" | "too_old" } {
  if (!when?.trim()) return { date: today };
  const w = when.trim().toLowerCase();
  const date = isIsoDate(w) ? (w as IsoDate) : resolveRelativeDate(w, today);
  if (!date) return { error: "unknown" };
  const diff = daysBetween(date, today);
  if (diff < 0) return { error: "future" };
  if (diff > 30) return { error: "too_old" };
  return { date };
}

const draftExpense: ToolSpec<typeof DraftExpenseInput> = {
  name: "draft_expense",
  description:
    "Registra un GASTO (dinero que salió) como borrador para que el usuario lo confirme. Úsala cuando el usuario diga que gastó, pagó o compró algo con un monto. No calcules conversiones: el sistema lo hace.",
  schema: DraftExpenseInput,
  roles: ["owner", "employee"],
  async run(input, run) {
    const parsedAmount =
      parseVenezuelanAmount(input.amount) ??
      (/^\d+(\.\d+)?$/.test(input.amount) ? new Decimal(input.amount) : null);
    if (!parsedAmount || !isPositiveAmount(parsedAmount)) {
      return {
        kind: "terminal",
        outbound: [es.clarification("No entendí el monto. ¿Cuánto fue?", [])],
        status: "ok",
      };
    }
    const when = resolveWhen(nz(input.when), run.ctx.today);
    if ("error" in when) {
      const q =
        when.error === "future"
          ? "Esa fecha es futura. ¿Cuándo fue el gasto?"
          : when.error === "too_old"
            ? `¿El gasto fue el ${input.when}? Es de hace más de un mes. Si es así, escríbelo con la fecha completa (por ejemplo 2026-08-15).`
            : "No entendí la fecha. ¿Fue hoy, ayer o qué día?";
      return { kind: "terminal", outbound: [es.clarification(q, [])], status: "ok" };
    }
    let amount = parsedAmount;
    let eurNote: string | null = null;
    if (input.currency === "EUR") {
      const e = await euroToBs(run.tx, parsedAmount, when.date);
      if (e === "no_eur")
        return { kind: "terminal", status: "ok", outbound: [es.clarification(NO_EUR_AMOUNT, [])] };
      amount = e.ves;
      eurNote = e.note;
    }
    const inferred = inferCurrency({
      explicit: eurNote ? "VES" : cur(input.currency),
      amount,
      threshold: new Decimal(run.ctx.vesThreshold),
      tenantDefault: run.ctx.defaultCurrency,
    });
    if (inferred.kind === "ask") {
      return { kind: "terminal", outbound: [es.currencyQuestion(input.amount)], status: "ok" };
    }
    // Un monto en euros ya se pasó a Bs con el euro del día: otra "tasa euro" lo convertiría
    // dos veces. El equivalente en $ sale a la tasa BCV como cualquier monto en Bs.
    const mr =
      input.currency === "EUR" ? null : await rateOverride(run.tx, nz(input.rate), when.date);
    if (mr === "invalid" || mr === "no_eur") return rateError(mr);
    // Corrección de un borrador de factura ("no, eran 50" por texto o voz): el borrador nuevo
    // reemplaza al pendiente y hereda su foto; si no, el respaldo se perdía (bug del 01/10).
    const target = draftTarget(run, input.corrects_draft);
    const inherited = inheritedAttachment(run, target);
    const category = matchCategory(run.ctx.categories, nz(input.category_name));
    const categoryId = category?.id ?? defaultCategoryId(run.ctx.categories);
    const categoryName =
      category?.name ?? run.ctx.categories.find((c) => c.id === categoryId)?.name ?? "Otros";
    try {
      const draft = await createExpenseDraft(
        run.tx,
        {
          tenantId: run.ctx.tenantId,
          phoneId: run.ctx.phoneId,
          amount,
          currency: inferred.currency,
          currencyInferred: inferred.kind === "inferred",
          categoryId,
          categoryName,
          description: withNote(input.description, eurNote),
          businessDate: when.date,
          sourceChannel: inherited ? "image" : run.ctx.sourceChannel,
          sourceMessageId: run.ctx.sourceMessageDbId,
          attachmentId: run.ctx.attachmentId ?? inherited,
          transcript: run.ctx.sourceChannel === "voice" ? run.userText : null,
          manualRate: mr,
          replaces: target?.id ?? null,
        },
        run.now,
      );
      return {
        kind: "terminal",
        status: "ok",
        outbound: [
          es.expenseDraft({
            pendingId: draft.pendingId,
            amount: draft.draft.amount,
            currency: draft.draft.currency,
            currencyInferred: draft.draft.currencyInferred,
            amountUsd: draft.draft.amountUsd,
            amountVes: draft.draft.amountVes,
            rateValue: draft.draft.rateValue,
            rateEffectiveDate: draft.draft.rateEffectiveDate,
            rateSource: draft.draft.rateSource,
            businessDate: draft.draft.businessDate,
            today: run.ctx.today,
            categoryName: draft.draft.categoryName,
            description: draft.draft.description,
            transcript: draft.draft.transcript,
            replacedPrevious: draft.replacedPrevious,
          }),
        ],
      };
    } catch (err) {
      if (err instanceof NoRateError)
        return { kind: "terminal", outbound: [es.noRate()], status: "ok" };
      throw err;
    }
  },
};

const draftExpenses: ToolSpec<typeof DraftExpensesInput> = {
  name: "draft_expenses",
  description:
    "Registra DOS O MÁS gastos dichos en un mismo mensaje, cada uno con su monto ('7$ en una arepa y 7,5$ en pádel', 'pagué 20 de luz, 15 de agua y 30 de internet'), como un solo borrador para confirmar. Nunca registres solo el primero con draft_expense. No calcules conversiones ni sumes: el sistema lo hace.",
  schema: DraftExpensesInput,
  roles: ["owner", "employee"],
  async run(input, run) {
    // Una sola tasa pedida (manual o euro) para todos los renglones, del día de cada gasto.
    const rateFor = async (date: IsoDate): Promise<RateOverride> =>
      rateOverride(run.tx, nz(input.rate), date);
    const first = await rateFor(run.ctx.today);
    if (first === "invalid") return rateError(first);
    const inputs: DraftInput[] = [];
    const ambiguous: string[] = [];
    for (const item of input.items) {
      const parsedAmount = parseAmount(item.amount);
      const label = item.description.trim() || item.amount;
      if (!parsedAmount) {
        return {
          kind: "terminal",
          outbound: [es.clarification(`No entendí el monto de ${label}. ¿Cuánto fue?`, [])],
          status: "ok",
        };
      }
      const when = resolveWhen(nz(item.when), run.ctx.today);
      if ("error" in when) {
        const q =
          when.error === "future"
            ? `Esa fecha es futura. ¿Cuándo fue lo de ${label}?`
            : when.error === "too_old"
              ? `¿Lo de ${label} fue el ${item.when}? Es de hace más de un mes. Si es así, escríbelo aparte con la fecha completa (por ejemplo 2026-08-15).`
              : `No entendí la fecha de ${label}. ¿Fue hoy, ayer o qué día?`;
        return { kind: "terminal", outbound: [es.clarification(q, [])], status: "ok" };
      }
      let amount = parsedAmount;
      let eurNote: string | null = null;
      if (item.currency === "EUR") {
        const e = await euroToBs(run.tx, parsedAmount, when.date);
        if (e === "no_eur")
          return {
            kind: "terminal",
            status: "ok",
            outbound: [es.clarification(NO_EUR_AMOUNT, [])],
          };
        amount = e.ves;
        eurNote = e.note;
      }
      const inferred = inferCurrency({
        explicit: eurNote ? "VES" : cur(item.currency),
        amount,
        threshold: new Decimal(run.ctx.vesThreshold),
        tenantDefault: run.ctx.defaultCurrency,
      });
      if (inferred.kind === "ask") {
        ambiguous.push(item.amount);
        continue;
      }
      const itemRate = await rateFor(when.date);
      if (itemRate === "invalid" || itemRate === "no_eur") return rateError(itemRate);
      const category = matchCategory(run.ctx.categories, nz(item.category_name));
      const categoryId = category?.id ?? defaultCategoryId(run.ctx.categories);
      const categoryName =
        category?.name ?? run.ctx.categories.find((c) => c.id === categoryId)?.name ?? "Otros";
      inputs.push({
        tenantId: run.ctx.tenantId,
        phoneId: run.ctx.phoneId,
        amount,
        currency: inferred.currency,
        currencyInferred: inferred.kind === "inferred",
        categoryId,
        categoryName,
        description: withNote(item.description, eurNote),
        businessDate: when.date,
        sourceChannel: run.ctx.sourceChannel,
        sourceMessageId: run.ctx.sourceMessageDbId,
        attachmentId: null,
        transcript: run.ctx.sourceChannel === "voice" ? run.userText : null,
        manualRate: itemRate,
      });
    }
    // Con moneda ambigua en algún renglón se pregunta una sola vez por todos (los botones vuelven
    // al agente con el mensaje original en el historial).
    if (ambiguous.length)
      return {
        kind: "terminal",
        outbound: [es.currencyQuestion(ambiguous.join(" y "))],
        status: "ok",
      };
    try {
      const target = draftTarget(run, input.corrects_draft);
      const draft = await createExpensesDraft(
        run.tx,
        inputs.map((i) => ({ ...i, replaces: target?.id ?? null })),
        run.now,
      );
      return {
        kind: "terminal",
        status: "ok",
        outbound: [
          es.expensesDraft({
            pendingId: draft.pendingId,
            items: draft.draft.items,
            today: run.ctx.today,
            transcript: draft.draft.items[0]?.transcript ?? null,
            replacedPrevious: draft.replacedPrevious,
          }),
        ],
      };
    } catch (err) {
      if (err instanceof NoRateError)
        return { kind: "terminal", outbound: [es.noRate()], status: "ok" };
      throw err;
    }
  },
};

/**
 * Tasa pedida por el usuario: "euro" → euro BCV del día del movimiento (02/10/2026); un número →
 * tasa manual (ADR-013). "invalid" si no se entiende; "no_eur" si no hay euro guardado para ese día.
 */
type RateOverride = Rate | null | "invalid" | "no_eur";
const EURO_RATE =
  /^(?:tasa\s+)?(?:del\s+)?(?:bcv\s*)?(?:euro|euros|eur|€)(?:\s+bcv)?(?:\s+del\s+d[ií]a)?$/i;

async function rateOverride(
  tx: Tx,
  raw: string | null,
  businessDate: IsoDate,
): Promise<RateOverride> {
  if (!raw) return null;
  if (EURO_RATE.test(raw.trim())) {
    try {
      return (await euroRateFor(tx, businessDate)).rate;
    } catch (err) {
      if (err instanceof NoEurRateError) return "no_eur";
      throw err;
    }
  }
  const manual = manualRateFrom(raw, businessDate);
  if (manual && manual !== "invalid" && !(await plausibleRate(tx, manual, businessDate)))
    return "invalid";
  return manual;
}

const NO_EUR =
  "Todavía no tengo la tasa euro del BCV de ese día. Dime la tasa (por ejemplo _tasa 973,93_) y la aplico.";

function rateError(r: "invalid" | "no_eur"): ToolOutcome {
  return {
    kind: "terminal",
    status: "ok",
    outbound: [es.clarification(r === "no_eur" ? NO_EUR : BAD_RATE, [])],
  };
}

/**
 * Monto en euros ("15 euros", "15 €", 02/10/2026): no hay cuentas en euros, así que se pasa a
 * bolívares con el euro BCV del día y se guarda en Bs (su equivalente en $ sale a tasa BCV). La
 * nota "15,00 € a tasa euro 973,93" va en la descripción para que se vea de dónde salió.
 */
async function euroToBs(
  tx: Tx,
  amount: Decimal,
  businessDate: IsoDate,
): Promise<{ ves: Decimal; note: string } | "no_eur"> {
  try {
    const { rate } = await euroRateFor(tx, businessDate);
    const n = (v: Decimal) => formatMoney(v, "VES").replace("Bs ", "");
    return {
      ves: amount.mul(rate.value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
      note: `${n(amount)} € a tasa euro ${n(rate.value)}`,
    };
  } catch (err) {
    if (err instanceof NoEurRateError) return "no_eur";
    throw err;
  }
}

const NO_EUR_AMOUNT =
  "Todavía no tengo la tasa euro del BCV de ese día. Dime el monto en dólares o en bolívares.";

const withNote = (description: string, note: string | null): string | null => {
  const d = description.trim();
  if (!note) return d || null;
  return d ? `${d} (${note})` : note;
};

/** "a tasa 850" → tasa manual; texto ilegible → "invalid" para pedir aclaración. */
function manualRateFrom(raw: string | null, businessDate: IsoDate): Rate | null | "invalid" {
  if (!raw) return null;
  // El modelo normaliza la tasa a punto decimal ("189,385" → "189.385"): un decimal con punto se
  // lee primero como decimal. Con la regla venezolana daba 189385, mil veces la tasa.
  const t = raw.trim();
  const v = /^\d+(\.\d+)?$/.test(t) ? new Decimal(t) : parseVenezuelanAmount(t);
  const r = v ? manualRate(v, businessDate) : null;
  return r ?? "invalid";
}

/** Una tasa manual entre la mitad y el doble de la BCV del día; fuera de eso es un error de tipeo. */
async function plausibleRate(tx: Tx, rate: Rate, businessDate: IsoDate): Promise<boolean> {
  try {
    const { rate: bcv } = await bcvRateFor(tx, businessDate);
    return rate.value.gte(bcv.value.div(2)) && rate.value.lte(bcv.value.mul(2));
  } catch (err) {
    if (err instanceof NoRateError) return true;
    throw err;
  }
}

const BAD_RATE = "No entendí la tasa. Escríbela como _tasa 857,89_.";

const METHOD_CURRENCY: Partial<Record<PaymentMethod, "USD" | "VES">> = {
  cash_usd: "USD",
  transfer_usd: "USD",
  zelle: "USD",
  cash_ves: "VES",
  transfer_ves: "VES",
};

function parseAmount(s: string): Decimal | null {
  const d = parseVenezuelanAmount(s) ?? (/^\d+(\.\d+)?$/.test(s) ? new Decimal(s) : null);
  return d && isPositiveAmount(d) ? d : null;
}

/**
 * Foto o PDF que hereda un borrador que corrige a otro sin traer archivo propio: "no es un gasto,
 * es una venta" sobre el borrador de un reporte de ventas conserva el PDF, sea cual sea el tipo.
 */
function inheritedAttachment(
  run: ToolRunCtx,
  target: ReturnType<typeof draftTarget>,
): string | null {
  if (run.ctx.attachmentId || !target) return null;
  return (target.payload.attachmentId as string | null | undefined) ?? null;
}

/** Canal y archivo de un borrador de venta: el propio (reporte de ventas) o el heredado. */
function attachmentFields(run: ToolRunCtx, target: ReturnType<typeof draftTarget>) {
  const inherited = inheritedAttachment(run, target);
  return {
    sourceChannel: inherited ? ("image" as const) : run.ctx.sourceChannel,
    attachmentId: run.ctx.attachmentId ?? inherited,
  };
}

const draftIncomeDayTotal: ToolSpec<typeof DraftIncomeDayTotalInput> = {
  name: "draft_income_day_total",
  description:
    "Registra la VENTA DEL DÍA (dinero que entró) como borrador para confirmar: un total y/o un desglose por método de pago. Úsala cuando el usuario diga que vendió, vendimos, entró, cobró o facturó una cantidad del día, con o sin desglose. No sumes ni conviertas: el sistema cuadra el desglose.",
  schema: DraftIncomeDayTotalInput,
  roles: ["owner", "employee"],
  async run(input, run) {
    const when = resolveWhen(nz(input.when), run.ctx.today);
    if ("error" in when)
      return {
        kind: "terminal",
        status: "ok",
        outbound: [es.clarification(whenQuestion(when.error, input.when), [])],
      };
    let statedAmount = input.total_amount ? parseAmount(input.total_amount) : null;
    if (input.total_amount && !statedAmount)
      return {
        kind: "terminal",
        status: "ok",
        outbound: [es.clarification("No entendí el total. ¿Cuánto vendiste?", [])],
      };
    if (!statedAmount && input.lines.length === 0)
      return {
        kind: "terminal",
        status: "ok",
        outbound: [
          es.clarification(
            "¿Cuánto vendiste? Ejemplo: _hoy vendí 350$: 200 efectivo, 150 pago móvil_",
            [],
          ),
        ],
      };
    // Total en euros: se pasa a Bs con el euro BCV del día (no hay cuentas en euros).
    if (statedAmount && input.total_currency === "EUR") {
      const e = await euroToBs(run.tx, statedAmount, when.date);
      if (e === "no_eur")
        return { kind: "terminal", status: "ok", outbound: [es.clarification(NO_EUR_AMOUNT, [])] };
      statedAmount = e.ves;
    }
    // Moneda del total: explícita, por magnitud, o por defecto del negocio; sin nada, USD para ventas.
    const statedCurrency = statedAmount
      ? input.total_currency === "EUR"
        ? "VES"
        : currencyFor(cur(input.total_currency), statedAmount, run.ctx)
      : null;
    const mr = await rateOverride(run.tx, nz(input.rate), when.date);
    if (mr === "invalid" || mr === "no_eur") return rateError(mr);
    const lines: { method: PaymentMethod; amount: Decimal; currency: "USD" | "VES" }[] = [];
    for (const l of input.lines) {
      let amount = parseAmount(l.amount);
      if (!amount)
        return {
          kind: "terminal",
          status: "ok",
          outbound: [
            es.clarification(
              `No entendí el monto de ${PAYMENT_METHOD_LABELS[l.method].toLowerCase()}. ¿Cuánto fue?`,
              [],
            ),
          ],
        };
      if (l.currency === "EUR") {
        const e = await euroToBs(run.tx, amount, when.date);
        if (e === "no_eur")
          return {
            kind: "terminal",
            status: "ok",
            outbound: [es.clarification(NO_EUR_AMOUNT, [])],
          };
        amount = e.ves;
      }
      const currency =
        (l.currency === "EUR" ? "VES" : cur(l.currency)) ??
        statedCurrency ??
        currencyFor(null, amount, run.ctx, METHOD_CURRENCY[l.method]);
      lines.push({ method: l.method, amount, currency });
    }
    try {
      const r = await createIncomeDayTotalDraft(
        run.tx,
        {
          tenantId: run.ctx.tenantId,
          phoneId: run.ctx.phoneId,
          businessDate: when.date,
          stated:
            statedAmount && statedCurrency
              ? { amount: statedAmount, currency: statedCurrency }
              : null,
          lines,
          ...attachmentFields(run, draftTarget(run, input.corrects_draft)),
          sourceMessageId: run.ctx.sourceMessageDbId,
          transcript: run.ctx.sourceChannel === "voice" ? run.userText : null,
          manualRate: mr,
          replaces: draftTarget(run, input.corrects_draft)?.id ?? null,
        },
        run.now,
      );
      return {
        kind: "terminal",
        status: "ok",
        outbound: [
          es.incomeDayTotalDraft({
            pendingId: r.pendingId,
            ...r.draft,
            today: run.ctx.today,
            replacedPrevious: r.replacedPrevious,
            methodLabel: (m) => PAYMENT_METHOD_LABELS[m as PaymentMethod] ?? m,
          }),
        ],
      };
    } catch (err) {
      if (err instanceof NoRateError)
        return { kind: "terminal", outbound: [es.noRate()], status: "ok" };
      throw err;
    }
  },
};

const draftIncomeSingle: ToolSpec<typeof DraftIncomeSingleInput> = {
  name: "draft_income_single",
  description:
    "Registra un INGRESO SUELTO (un pago puntual que recibió, no el total del día) como borrador: 'me pagaron 30$ por zelle del carro del abogado', 'cobré 50$ de la moto'. Si habla del total del día o de varias formas de pago, usa draft_income_day_total.",
  schema: DraftIncomeSingleInput,
  roles: ["owner", "employee"],
  async run(input, run) {
    const parsedAmount = parseAmount(input.amount);
    if (!parsedAmount)
      return {
        kind: "terminal",
        status: "ok",
        outbound: [es.clarification("No entendí el monto. ¿Cuánto te pagaron?", [])],
      };
    const when = resolveWhen(nz(input.when), run.ctx.today);
    if ("error" in when)
      return {
        kind: "terminal",
        status: "ok",
        outbound: [es.clarification(whenQuestion(when.error, input.when), [])],
      };
    // Un monto en euros ya se pasó a Bs con el euro del día: otra "tasa euro" lo convertiría
    // dos veces. El equivalente en $ sale a la tasa BCV como cualquier monto en Bs.
    const mr =
      input.currency === "EUR" ? null : await rateOverride(run.tx, nz(input.rate), when.date);
    if (mr === "invalid" || mr === "no_eur") return rateError(mr);
    const method: PaymentMethod = input.method;
    let amount = parsedAmount;
    let eurNote: string | null = null;
    if (input.currency === "EUR") {
      const e = await euroToBs(run.tx, parsedAmount, when.date);
      if (e === "no_eur")
        return { kind: "terminal", status: "ok", outbound: [es.clarification(NO_EUR_AMOUNT, [])] };
      amount = e.ves;
      eurNote = e.note;
    }
    const explicit = eurNote ? "VES" : (cur(input.currency) ?? METHOD_CURRENCY[method] ?? null);
    const currency = currencyFor(explicit, amount, run.ctx);
    try {
      const r = await createIncomeSingleDraft(
        run.tx,
        {
          tenantId: run.ctx.tenantId,
          phoneId: run.ctx.phoneId,
          amount,
          currency,
          currencyInferred: !explicit,
          method,
          description: withNote(input.description, eurNote),
          businessDate: when.date,
          ...attachmentFields(run, draftTarget(run, input.corrects_draft)),
          sourceMessageId: run.ctx.sourceMessageDbId,
          transcript: run.ctx.sourceChannel === "voice" ? run.userText : null,
          manualRate: mr,
          replaces: draftTarget(run, input.corrects_draft)?.id ?? null,
        },
        run.now,
      );
      return {
        kind: "terminal",
        status: "ok",
        outbound: [
          es.incomeSingleDraft({
            pendingId: r.pendingId,
            ...r.draft,
            today: run.ctx.today,
            methodLabel: PAYMENT_METHOD_LABELS[method],
            replacedPrevious: r.replacedPrevious,
          }),
        ],
      };
    } catch (err) {
      if (err instanceof NoRateError)
        return { kind: "terminal", outbound: [es.noRate()], status: "ok" };
      throw err;
    }
  },
};

const getSummary: ToolSpec<typeof GetSummaryInput> = {
  name: "get_summary",
  description:
    "Cierre del día, resumen de un período o total de una categoría: 'cierre', 'cómo fue hoy', 'cómo va el mes', 'cuánto llevo esta semana', 'cuánto gasté en insumos este mes', 'del 1 al 15'. Solo lectura. Lo ve el dueño.",
  schema: GetSummaryInput,
  roles: ["owner", "employee"],
  async run(input, run) {
    if (run.ctx.role !== "owner")
      return { kind: "terminal", status: "ok", outbound: [es.ownerOnly()] };
    const outbound = await renderSummary(run.tx, {
      tenantId: run.ctx.tenantId,
      today: run.ctx.today,
      dashboardUrl: run.ctx.dashboardUrl,
      period: input.period,
      from: input.from && isIsoDate(input.from) ? input.from : null,
      to: input.to && isIsoDate(input.to) ? input.to : null,
      categoryName: nz(input.category_name),
    });
    return { kind: "terminal", status: "ok", outbound: [outbound] };
  },
};

const getBudgets: ToolSpec<typeof GetBudgetsInput> = {
  name: "get_budgets",
  description:
    "Presupuestos por categoría: cuánto le queda o cómo va ('cuánto me queda en insumos', 'cómo voy con el presupuesto', 'me pasé en comida?'). Solo lectura; los presupuestos se ponen en el dashboard. Lo ve el dueño.",
  schema: GetBudgetsInput,
  roles: ["owner", "employee"],
  async run(input, run) {
    const reply = (o: Outbound) => ({
      kind: "terminal" as const,
      status: "ok" as const,
      outbound: [o],
    });
    if (run.ctx.role !== "owner") return reply(es.budgetsOwnerOnly());
    if (input.wants_to_set) return reply(es.setBudgetInDashboard(run.ctx.dashboardUrl));
    const all = await budgetStatuses(run.tx, run.ctx.tenantId, run.ctx.today);
    const name = input.category_name.trim();
    if (!name) {
      return reply(
        all.length ? es.budgetsSummary(all, run.ctx.today) : es.noBudgets(run.ctx.dashboardUrl),
      );
    }
    const withBudget = matchCategoryName(all, name);
    if (withBudget) return reply(es.budgetsSummary([withBudget], run.ctx.today));
    const category = matchCategoryName(run.ctx.categories, name);
    if (category) return reply(es.categoryWithoutBudget(category.name, run.ctx.dashboardUrl));
    return reply(
      es.categoryNotFound(
        name,
        run.ctx.categories.slice(0, 3).map((c) => c.name),
      ),
    );
  },
};

const renewPlan: ToolSpec<typeof RenewPlanInput> = {
  name: "renew_plan",
  description:
    "El plan del ASISTENTE (la suscripción a este servicio): cuándo vence, cuánto cuesta, renovarlo, cambiarse de plan o reportar que ya lo pagó ('quiero renovar', '¿cuándo se me vence el plan?', 'pásame a negocio plus', 'ya pagué el plan, ref 123456'). No es para gastos del negocio.",
  schema: RenewPlanInput,
  roles: ["owner", "employee"],
  async run(input, run) {
    const reply = (o: Outbound) => ({
      kind: "terminal" as const,
      status: "ok" as const,
      outbound: [o],
    });
    if (run.ctx.role !== "owner") return reply(es.renewOwnerOnly());
    const c = {
      tenantId: run.ctx.tenantId,
      phoneId: run.ctx.phoneId,
      now: run.now,
      dest: run.ctx.billing?.dest ?? {},
      supportHint: run.ctx.billing?.supportHint ?? null,
    };
    const method = input.method === "unknown" ? null : input.method;
    const reference = input.reference.replace(/[^A-Za-z0-9-]/g, "").toUpperCase();
    if (reference.length >= 4)
      return reply(await renewReferenceReply(run.tx, c, reference, method));
    const months = Number.isInteger(input.months) ? input.months : 1;
    const plan = input.plan === "current" ? null : input.plan;
    if (method) {
      const [t] = await run.tx
        .select({ plan: schema.tenant.plan })
        .from(schema.tenant)
        .where(eq(schema.tenant.id, run.ctx.tenantId));
      const current = planFromName(t?.plan) ?? "negocio";
      return reply(await renewPayToReply(run.tx, c, { method, plan: plan ?? current, months }));
    }
    return reply(await renewOfferReply(run.tx, c, { plan, months }));
  },
};

async function categoryNameOf(run: ToolRunCtx, categoryId: string | null): Promise<string | null> {
  if (!categoryId) return null;
  return run.ctx.categories.find((c) => c.id === categoryId)?.name ?? null;
}

const amendLast: ToolSpec<typeof AmendLastInput> = {
  name: "amend_last_movement",
  description:
    "Corrige el ÚLTIMO movimiento ya guardado (gasto o venta) cuando el usuario dice 'no, eran 25', 'era en bolívares', 'es mantenimiento', 'fue ayer', 'a tasa 850'. Solo los campos que cambian; los demás null. Si hay un borrador sin guardar en corrección, NO uses esta: usa la herramienta del borrador.",
  schema: AmendLastInput,
  roles: ["owner", "employee"],
  async run(input, run) {
    const m = await lastMovementByPhone(run.tx, run.ctx.tenantId, run.ctx.phoneId);
    if (!m) return { kind: "terminal", status: "ok", outbound: [es.nothingToAmend()] };
    if (isTooOld(m, run.now))
      return { kind: "terminal", status: "ok", outbound: [es.tooOld(run.ctx.dashboardUrl)] };
    const changes: AmendChanges = {};
    if (input.amount) {
      const a = parseAmount(input.amount);
      if (!a)
        return {
          kind: "terminal",
          status: "ok",
          outbound: [es.clarification("No entendí el monto. ¿Cuánto era?", [])],
        };
      changes.amount = a;
    }
    if (input.currency !== "keep") changes.currency = input.currency;
    if (nz(input.description)) changes.description = input.description.trim();
    if (input.when) {
      const w = resolveWhen(nz(input.when), run.ctx.today);
      if ("error" in w)
        return {
          kind: "terminal",
          status: "ok",
          outbound: [es.clarification(whenQuestion(w.error, input.when), [])],
        };
      changes.businessDate = w.date;
    }
    if (input.category_name) {
      const c =
        matchCategory(run.ctx.categories, input.category_name) ??
        (await findCategory(run.tx, run.ctx.tenantId, input.category_name));
      if (!c) {
        return {
          kind: "terminal",
          status: "ok",
          outbound: [
            es.categoryNotFound(
              input.category_name,
              run.ctx.categories.slice(0, 3).map((x) => x.name),
            ),
          ],
        };
      }
      changes.categoryId = c.id;
      changes.categoryName = c.name;
    }
    if (input.method !== "keep" && m.type === "income") changes.paymentMethod = input.method;
    if (input.rate) {
      const r = await rateOverride(
        run.tx,
        nz(input.rate),
        changes.businessDate ?? (m.businessDate as IsoDate),
      );
      if (r === "invalid" || r === "no_eur") return rateError(r);
      if (!r) return rateError("invalid");
      changes.manualRate = r;
    }
    if (Object.keys(changes).length === 0)
      return {
        kind: "terminal",
        status: "ok",
        outbound: [
          es.clarification("¿Qué cambio? Ejemplo: _eran 25_, _es mantenimiento_, _fue ayer_.", []),
        ],
      };
    try {
      const r = await createEditLastDraft(
        run.tx,
        {
          tenantId: run.ctx.tenantId,
          phoneId: run.ctx.phoneId,
          movement: m,
          categoryName: await categoryNameOf(run, m.categoryId),
          changes,
        },
        run.now,
      );
      return {
        kind: "terminal",
        status: "ok",
        outbound: [
          es.amendDraft({
            pendingId: r.pendingId,
            type: r.draft.type,
            before: r.draft.before,
            after: r.draft.after,
            changed: r.draft.changed,
            methodLabel: (x) => PAYMENT_METHOD_LABELS[x as PaymentMethod] ?? x,
          }),
        ],
      };
    } catch (err) {
      if (err instanceof NoRateError)
        return { kind: "terminal", outbound: [es.noRate()], status: "ok" };
      throw err;
    }
  },
};

const deleteLast: ToolSpec<typeof DeleteLastInput> = {
  name: "delete_last_movement",
  description:
    "Borra movimientos YA GUARDADOS en los últimos 30 minutos: el último ('bórralo', 'elimina eso', 'quita el último', 'ese no va'), varios ('bórralos', 'borra los 3 últimos', 'elimina esos gastos') o uno que nombra ('borra el de la arepa'). Pide confirmación con botones.",
  schema: DeleteLastInput,
  roles: ["owner", "employee"],
  async run(input, run) {
    return deleteLastFlow(run, input);
  },
};

const DELETE_ONE: DeleteLastInput = { scope: "last", count: 0, description: "" };

/** Compartido con la palabra clave "bórralo" (sin LLM), que borra solo el último. */
export async function deleteLastFlow(
  run: ToolRunCtx,
  input: DeleteLastInput = DELETE_ONE,
): Promise<ToolOutcome> {
  const recent = await recentMovementsByPhone(run.tx, run.ctx.tenantId, run.ctx.phoneId);
  if (!recent.length) return { kind: "terminal", status: "ok", outbound: [es.nothingToAmend()] };
  const fresh = recent.filter((m) => !isTooOld(m, run.now));
  const newest = fresh[0];
  if (!newest)
    return { kind: "terminal", status: "ok", outbound: [es.tooOld(run.ctx.dashboardUrl)] };
  const wanted = Math.min(Math.max(Math.trunc(input.count) || 1, 1), DELETE_MANY_MAX);
  let chosen: Movement[];
  switch (input.scope) {
    case "last_batch":
      // Un Guardar escribe todos sus movimientos en una transacción: comparten created_at.
      chosen = fresh.filter((m) => m.createdAt.getTime() === newest.createdAt.getTime());
      break;
    case "last_n":
      chosen = fresh.slice(0, wanted);
      break;
    case "matching": {
      const words = norm(input.description)
        .split(/\s+/)
        .filter((w) => w.length > 2);
      const named = async (m: Movement) =>
        norm(`${m.description ?? ""} ${(await categoryNameOf(run, m.categoryId)) ?? ""}`);
      chosen = [];
      for (const m of fresh) {
        const text = await named(m);
        if (words.length && words.some((w) => text.includes(w))) chosen.push(m);
      }
      if (!chosen.length)
        return {
          kind: "terminal",
          status: "ok",
          outbound: [
            es.clarification(
              `No encontré "${input.description.trim()}" entre lo que guardaste en los últimos 30 minutos. ¿Cuál quieres borrar?`,
              [],
            ),
          ],
        };
      break;
    }
    default:
      chosen = [newest];
  }
  const methodLabel = (x: string) => PAYMENT_METHOD_LABELS[x as PaymentMethod] ?? x;
  const first = chosen[0] ?? newest;
  if (chosen.length === 1) {
    const r = await createDeleteLastDraft(
      run.tx,
      {
        tenantId: run.ctx.tenantId,
        phoneId: run.ctx.phoneId,
        movement: first,
        categoryName: await categoryNameOf(run, first.categoryId),
      },
      run.now,
    );
    return {
      kind: "terminal",
      status: "ok",
      outbound: [
        es.deleteDraft({
          pendingId: r.pendingId,
          type: r.draft.type,
          snapshot: r.draft.snapshot,
          today: run.ctx.today,
          methodLabel,
          // Los de un mismo Guardar comparten hora: ninguno es "el último" por sí solo.
          latest:
            first.id === newest.id &&
            fresh.filter((m) => m.createdAt.getTime() === newest.createdAt.getTime()).length === 1,
        }),
      ],
    };
  }
  const movements = [];
  for (const m of chosen)
    movements.push({ movement: m, categoryName: await categoryNameOf(run, m.categoryId) });
  const r = await createDeleteManyDraft(
    run.tx,
    { tenantId: run.ctx.tenantId, phoneId: run.ctx.phoneId, movements },
    run.now,
  );
  // Pidió más de los que caben en la ventana de 30 minutos: los viejos van por el dashboard.
  const olderLeft =
    input.scope === "last_n" && wanted > chosen.length && recent.length > fresh.length;
  return {
    kind: "terminal",
    status: "ok",
    outbound: [
      es.deleteManyDraft({
        pendingId: r.pendingId,
        items: r.draft.items,
        today: run.ctx.today,
        methodLabel,
        dashboardUrl: olderLeft ? run.ctx.dashboardUrl : null,
      }),
    ],
  };
}

/** Moneda de una venta: explícita > umbral de magnitud > moneda del método > defecto del negocio > USD. */
function currencyFor(
  explicit: "USD" | "VES" | null,
  amount: Decimal,
  ctx: AgentContext,
  methodHint: "USD" | "VES" | undefined = undefined,
): "USD" | "VES" {
  if (explicit) return explicit;
  if (amount.gte(new Decimal(ctx.vesThreshold))) return "VES";
  return methodHint ?? ctx.defaultCurrency ?? "USD";
}

function whenQuestion(error: "unknown" | "future" | "too_old", when: string | null): string {
  return error === "future"
    ? "Esa fecha es futura. ¿De qué día es la venta?"
    : error === "too_old"
      ? `¿La venta fue el ${when}? Es de hace más de un mes. Si es así, escríbela con la fecha completa (por ejemplo 2026-08-15).`
      : "No entendí la fecha. ¿Fue hoy, ayer o qué día?";
}

const askClarification: ToolSpec<typeof AskClarificationInput> = {
  name: "ask_clarification",
  description:
    "Haz UNA pregunta corta cuando falte un dato imprescindible (monto, o qué se compró) o el mensaje sea ambiguo entre gasto y venta. No la uses para pedir la moneda ni la fecha: draft_expense las resuelve.",
  schema: AskClarificationInput,
  roles: ["owner", "employee"],
  async run(input, run) {
    const question = numbersAreGrounded(input.question, run.groundingText ?? run.userText)
      ? input.question
      : "No entendí bien. ¿Me lo repites con el monto y en qué lo gastaste?";
    return {
      kind: "terminal",
      outbound: [es.clarification(question, input.options)],
      status: "ok",
    };
  },
};

const rejectOutOfScope: ToolSpec<typeof RejectOutOfScopeInput> = {
  name: "reject_out_of_scope",
  description:
    "El mensaje no es un gasto, una venta, un ingreso, una corrección, un cierre o consulta, ni la tasa: saludos largos, preguntas generales, pedir que redactes algo, chistes, cualquier otra tarea (general_chat). También si pide algo de caja que no existe: inventario, deudas, clientes, presupuestos, corregir un movimiento que no sea el último (other_business_task). Borrar uno o varios de los últimos 30 minutos SÍ se puede: usa delete_last_movement.",
  schema: RejectOutOfScopeInput,
  roles: ["owner", "employee"],
  async run(input) {
    return {
      kind: "terminal",
      outbound: [input.reason === "other_business_task" ? es.comingSoon() : es.outOfScope()],
      status: "rejected_out_of_scope",
    };
  },
};

const getBcvRate: ToolSpec<typeof GetBcvRateInput> = {
  name: "get_bcv_rate",
  description:
    "Devuelve la tasa BCV vigente hoy y la próxima publicada. Úsala cuando pregunten por la tasa, el dólar o el BCV.",
  schema: GetBcvRateInput,
  roles: ["owner", "employee"],
  async run(_input, run) {
    return {
      kind: "terminal",
      outbound: [es.rate(await getRateInfo(run.tx, run.ctx.today))],
      status: "ok",
    };
  },
};

/**
 * Guardrail (Fase 3): todo número en una aclaración redactada por el modelo debe existir en el
 * texto del usuario. Si no, se usa una aclaración genérica.
 */
export function numbersAreGrounded(text: string, userText: string): boolean {
  const nums = text.match(/\d[\d.,]*/g) ?? [];
  if (nums.length === 0) return true;
  const source = norm(userText).replace(/[.,]/g, "");
  return nums.every((n) => source.includes(n.replace(/[.,]/g, "")));
}

export const ALL_TOOLS: ToolSpec<z.ZodType>[] = [
  draftExpense,
  draftExpenses,
  draftIncomeDayTotal,
  draftIncomeSingle,
  getSummary,
  getBudgets,
  renewPlan,
  amendLast,
  deleteLast,
  askClarification,
  rejectOutOfScope,
  getBcvRate,
] as ToolSpec<z.ZodType>[];

export function toolsForRole(role: "owner" | "employee"): ToolSpec<z.ZodType>[] {
  return ALL_TOOLS.filter((t) => t.roles.includes(role));
}

/**
 * Palabras clave que el modo `strict` de la API no admite. Zod las genera desde `.max()` y
 * similares; se quitan del esquema que ve el modelo y siguen validándose con Zod en el backend.
 */
const UNSUPPORTED_IN_STRICT = new Set([
  "maxLength",
  "minLength",
  "maxItems",
  "minItems",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "uniqueItems",
  "default",
]);

export function stripUnsupportedKeywords(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupportedKeywords);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED_IN_STRICT.has(k)) continue;
    out[k] = stripUnsupportedKeywords(v);
  }
  return out;
}

/** Parámetros con tipo unión (`anyOf` o `type: [...]`) en un esquema; la API estricta admite 16 en total. */
export function countUnions(node: unknown): number {
  if (Array.isArray(node)) return node.reduce<number>((n, x) => n + countUnions(x), 0);
  if (!node || typeof node !== "object") return 0;
  const o = node as Record<string, unknown>;
  let n = 0;
  if (Array.isArray(o.anyOf) || Array.isArray(o.oneOf) || Array.isArray(o.type)) n += 1;
  for (const v of Object.values(o)) n += countUnions(v);
  return n;
}

export const STRICT_UNION_LIMIT = 16;

/** JSON Schema para el modelo, con `additionalProperties: false` (requisito de `strict`). */
export function toLlmToolDef(t: ToolSpec<z.ZodType>): LlmToolDef {
  const json = stripUnsupportedKeywords(z.toJSONSchema(t.schema)) as Record<string, unknown>;
  delete json.$schema;
  json.additionalProperties = false;
  if (!("properties" in json)) json.properties = {};
  return { name: t.name, description: t.description, inputSchema: json };
}

export { addDays };
