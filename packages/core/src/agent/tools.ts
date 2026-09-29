import { and, eq, schema, type Tx } from "@caja/db";
import { z } from "zod";
import { inferCurrency } from "../domain/currency-rule";
import {
  addDays,
  daysBetween,
  type IsoDate,
  isIsoDate,
  resolveRelativeDate,
} from "../domain/dates";
import { Decimal, isPositiveAmount, parseVenezuelanAmount } from "../domain/money";
import { createExpenseDraft } from "../ledger/drafts";
import { NoRateError } from "../ledger/rate-for";
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
  /** Texto del usuario en este turno (para validar cifras en aclaraciones). */
  userText: string;
  now: Date;
};

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

const Currency = z.enum(["USD", "VES"]);

export const DraftExpenseInput = z.object({
  amount: z
    .string()
    .describe(
      'Monto tal como lo dijo el usuario, normalizado a dígitos con punto decimal. "15,50" → "15.50"; "450 mil" → "450000"; "medio millón" → "500000".',
    ),
  currency: Currency.nullable().describe(
    "USD si dijo $, dólares, verdes, usd. VES si dijo bs, bolos, bolívares. null si no lo dijo.",
  ),
  description: z
    .string()
    .max(120)
    .describe(
      "Qué se compró o pagó, en 1 a 5 palabras, sin el monto. Ej: 'Champú', 'Gasolina', 'Comida del personal'.",
    ),
  category_name: z
    .string()
    .nullable()
    .describe(
      "Una categoría de la lista del negocio, copiada exactamente, o null si ninguna encaja claramente.",
    ),
  when: z
    .string()
    .nullable()
    .describe(
      'Cuándo fue: "hoy", "ayer", "antier", un día de la semana ("lunes"), o una fecha ISO YYYY-MM-DD. null si no lo dijo (se asume hoy).',
    ),
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
    const amount =
      parseVenezuelanAmount(input.amount) ??
      (/^\d+(\.\d+)?$/.test(input.amount) ? new Decimal(input.amount) : null);
    if (!amount || !isPositiveAmount(amount)) {
      return {
        kind: "terminal",
        outbound: [es.clarification("No entendí el monto. ¿Cuánto fue?", [])],
        status: "ok",
      };
    }
    const when = resolveWhen(input.when, run.ctx.today);
    if ("error" in when) {
      const q =
        when.error === "future"
          ? "Esa fecha es futura. ¿Cuándo fue el gasto?"
          : when.error === "too_old"
            ? `¿El gasto fue el ${input.when}? Es de hace más de un mes. Si es así, escríbelo con la fecha completa (por ejemplo 2026-08-15).`
            : "No entendí la fecha. ¿Fue hoy, ayer o qué día?";
      return { kind: "terminal", outbound: [es.clarification(q, [])], status: "ok" };
    }
    const inferred = inferCurrency({
      explicit: input.currency,
      amount,
      threshold: new Decimal(run.ctx.vesThreshold),
      tenantDefault: run.ctx.defaultCurrency,
    });
    if (inferred.kind === "ask") {
      return {
        kind: "terminal",
        outbound: [
          es.clarification(
            `¿${input.amount} en qué moneda? Responde por ejemplo: ${input.amount}$ o ${input.amount} bs`,
            [],
          ),
        ],
        status: "ok",
      };
    }
    const category = matchCategory(run.ctx.categories, input.category_name);
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
          description: input.description.trim() || null,
          businessDate: when.date,
          sourceChannel: run.ctx.sourceChannel,
          sourceMessageId: run.ctx.sourceMessageDbId,
          attachmentId: null,
          transcript: run.ctx.sourceChannel === "voice" ? run.userText : null,
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

const askClarification: ToolSpec<typeof AskClarificationInput> = {
  name: "ask_clarification",
  description:
    "Haz UNA pregunta corta cuando falte un dato imprescindible (monto, o qué se compró) o el mensaje sea ambiguo entre gasto y venta. No la uses para pedir la moneda ni la fecha: draft_expense las resuelve.",
  schema: AskClarificationInput,
  roles: ["owner", "employee"],
  async run(input, run) {
    const question = numbersAreGrounded(input.question, run.userText)
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
    "El mensaje no es un gasto, una venta, una consulta de caja ni la tasa: saludos largos, preguntas generales, pedir que redactes algo, chistes, cualquier otra tarea. También si pide algo de caja que aún no existe (ventas, cierres): usa esta herramienta.",
  schema: RejectOutOfScopeInput,
  roles: ["owner", "employee"],
  async run() {
    return { kind: "terminal", outbound: [es.outOfScope()], status: "rejected_out_of_scope" };
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

/** JSON Schema para el modelo, con `additionalProperties: false` (requisito de `strict`). */
export function toLlmToolDef(t: ToolSpec<z.ZodType>): LlmToolDef {
  const json = stripUnsupportedKeywords(z.toJSONSchema(t.schema)) as Record<string, unknown>;
  delete json.$schema;
  json.additionalProperties = false;
  if (!("properties" in json)) json.properties = {};
  return { name: t.name, description: t.description, inputSchema: json };
}

/** Borrador pendiente en corrección, para el contexto del modelo. */
export async function pendingDraftFor(tx: Tx, phoneId: string) {
  const [row] = await tx
    .select()
    .from(schema.pendingAction)
    .where(
      and(eq(schema.pendingAction.phoneId, phoneId), eq(schema.pendingAction.status, "pending")),
    );
  return row ?? null;
}

export { addDays };
