import { z } from "zod";
import {
  businessDateOf,
  caracasInstant,
  type DueAt,
  dueBaseOf,
  resolveDueAt,
} from "../domain/dates";
import { Decimal, isPositiveAmount, parseVenezuelanAmount } from "../domain/money";
import {
  cancelReminder,
  createReminder,
  getReminder,
  type ReminderChange,
  type ReminderCurrency,
  type ReminderRow,
  updateReminder,
} from "../reminders/store";
import { es, type Outbound } from "../render/index";
import type { ToolOutcome, ToolRunCtx, ToolSpec } from "./tools";
import type { AgentContext, ReminderRef } from "./types";

/**
 * Recordatorios de plata por chat (PRD hábitos US-303, US-308). El modelo copia lo que dijo el
 * usuario; el día y la hora los calcula `resolveDueAt`. Sin estricto: los esquemas son de texto y
 * enum, y el conjunto estricto ya está cerca de su tope (STRICT_TOOL_LIMIT).
 */
export const REMINDER_TOOL_NAMES = ["create_reminder", "update_reminder", "cancel_reminder"];

const ReminderCurrencyIn = z.enum(["USD", "VES", "EUR", "unknown"]);
const nz = (s: string): string | null => (s.trim() ? s.trim() : null);

const TEXT_FIELD = z
  .string()
  .describe(
    "Qué hay que hacer, en 2 a 6 palabras con las palabras del usuario, en infinitivo, sin monto ni fecha ('pagar la luz', 'cobrarle a Pedro', 'renovar el plan de datos'). Neutral: NUNCA insultos ni calificativos sobre nadie ('el sinvergüenza de Pedro me debe' → 'cobrarle a Pedro').",
  );
const WHEN_FIELD = z
  .string()
  .describe(
    "Cuándo avisar, copiado tal como lo dijo el usuario, con el día y la hora: 'el viernes a las 9 am', 'mañana', 'el 15 a las 3', 'fin de mes', 'en 3 días', 'hoy en la noche'. Si responde a '¿Para qué día te lo recuerdo?', lo que dijo ahora. '' si no lo dijo.",
  );
const AMOUNT_FIELD = z
  .string()
  .describe('Monto si lo dijo, normalizado a dígitos con punto ("20$" → "20"). "" si no lo dijo.');
const CURRENCY_FIELD = ReminderCurrencyIn.describe(
  "USD si dijo $, dólares, verdes, usd o usdt. VES si dijo bs, bolos, bolívares. EUR si dijo euros o €. unknown si no lo dijo o no hay monto.",
);
const COUNTERPARTY_FIELD = z
  .string()
  .describe("A quién se le paga o quién debe, si lo nombra ('Pedro', 'Corpoelec'). '' si no.");
const REF_FIELD = z
  .string()
  .describe(
    'El recordatorio, por su ref de la lista de recordatorios ("r1", "r2"…). "" si es el que el usuario está corrigiendo o si solo hay uno.',
  );

export const CreateReminderInput = z.object({
  text: TEXT_FIELD.max(120),
  kind: z
    .enum(["pay", "collect", "other_money", "not_money"])
    .describe(
      "pay: pagar algo o a alguien (luz, alquiler, una cuota, una deuda suya). collect: cobrar o que le paguen. other_money: otra cosa de plata (cambiar dólares, depositar, renovar un plan). not_money: no es de plata (llamar a mamá, una cita, tomar una pastilla).",
    ),
  amount: AMOUNT_FIELD,
  currency: CURRENCY_FIELD,
  counterparty: COUNTERPARTY_FIELD,
  when: WHEN_FIELD,
});

export const UpdateReminderInput = z.object({
  reminder: REF_FIELD,
  text: TEXT_FIELD.max(120).describe(
    "El texto nuevo SOLO si lo cambia ('pagar el agua'); '' si no cambia. Neutral, sin calificativos.",
  ),
  amount: AMOUNT_FIELD.describe('El monto nuevo SOLO si lo cambia ("son 25$" → "25"); "" si no.'),
  currency: CURRENCY_FIELD,
  when: WHEN_FIELD.describe(
    "El día y/o la hora nuevos SOLO si los cambia, tal como los dijo ('el lunes a las 3 pm', 'a las 4 pm', 'el jueves'); '' si no cambian.",
  ),
});

export const CancelReminderInput = z.object({ reminder: REF_FIELD });

function parseAmount(s: string): Decimal | null {
  const d = parseVenezuelanAmount(s) ?? (/^\d+(\.\d+)?$/.test(s) ? new Decimal(s) : null);
  return d && isPositiveAmount(d) ? d : null;
}

/** Moneda del monto: la dicha; si no, Bs por magnitud, la del negocio o $. Nunca se convierte. */
function reminderCurrency(
  c: z.infer<typeof ReminderCurrencyIn>,
  amount: Decimal,
  ctx: AgentContext,
): ReminderCurrency {
  if (c !== "unknown") return c;
  if (amount.gte(new Decimal(ctx.vesThreshold))) return "VES";
  return ctx.defaultCurrency ?? "USD";
}

const terminal = (
  outbound: Outbound[],
  markers?: { name: string; args: unknown }[],
): ToolOutcome => ({ kind: "terminal", outbound, status: "ok", ...(markers ? { markers } : {}) });

const rejected = (out: Outbound, reason: "employee" | "non_money" | "limit") =>
  terminal([out], [{ name: "reminder_rejected", args: { reason } }]);

/** H18–H18d para lo que `resolveDueAt` no pudo ubicar. */
function askDate(due: Exclude<DueAt, { kind: "ok" | "ambiguous_hour" }>, now: Date): Outbound {
  if (due.kind === "hour_passed")
    return es.reminderAskDate(
      "hour_passed",
      caracasInstant(businessDateOf(now), due.hour, due.minute),
    );
  return es.reminderAskDate(due.kind);
}

/**
 * Lo que espera la respuesta a H17 («¿9 de la mañana o de la noche?»): va en la marca
 * `reminder_draft` de la pregunta, y el toque `rem:ampm` lo termina sin la IA.
 */
export type ReminderDraft = {
  /** Con id: corrige ese recordatorio. Sin id: es uno nuevo. */
  id?: string;
  text?: string;
  kind?: "pay" | "collect" | "other_money";
  amount?: string | null;
  currency?: ReminderCurrency | null;
  counterparty?: string | null;
  hour: number;
  minute: number;
  date: string | null;
};

export const REMINDER_DRAFT = "reminder_draft";

export function reminderView(r: ReminderRow | ReminderRef): es.ReminderView {
  return {
    id: r.id,
    text: r.text,
    kind: r.kind as es.ReminderView["kind"],
    amount: r.amount,
    currency: r.currency,
    dueAt: r.dueAt,
  };
}

const createReminderTool: ToolSpec<typeof CreateReminderInput> = {
  name: "create_reminder",
  description:
    "El usuario pide que le RECUERDES algo de plata en un momento futuro ('recuérdame pagar la luz el viernes a las 9 am', 'avísame el lunes que Pedro me debe 20$', 'el 15 tengo que pagar el alquiler, recuérdamelo'). Solo crea el recordatorio: no registra gasto ni venta. Si no es de plata, kind not_money (el sistema le dice que solo recuerda pagos y cobros). Si ya pagó o cobró ('pagué la luz, recuérdame que…'), eso es un gasto o venta, no un recordatorio.",
  schema: CreateReminderInput,
  roles: ["owner", "employee"],
  strict: false,
  async run(input, run) {
    const r = run.ctx.reminders;
    if (!r) return terminal([es.outOfScope()]);
    if (run.ctx.role !== "owner") return rejected(es.reminderEmployee(), "employee");
    if (input.kind === "not_money") return rejected(es.reminderNotMoney(), "non_money");
    if (r.pending >= r.limit) return rejected(es.reminderLimit(r.pending, r.trial), "limit");
    const amount = parseAmount(input.amount);
    const fields = {
      text: (nz(input.text) ?? run.userText).slice(0, 80),
      kind: input.kind,
      amount: amount ? amount.toFixed(2) : null,
      currency: amount ? reminderCurrency(input.currency, amount, run.ctx) : null,
      counterparty: nz(input.counterparty)?.slice(0, 40) ?? null,
    };
    const due = resolveDueAt(nz(input.when) ?? run.userText, run.now);
    if (due.kind === "ambiguous_hour") {
      const draft: ReminderDraft = {
        ...fields,
        hour: due.hour,
        minute: due.minute,
        date: due.date,
      };
      return terminal(
        [es.reminderAskAmPm(due.hour, due.minute)],
        [{ name: REMINDER_DRAFT, args: draft }],
      );
    }
    if (due.kind !== "ok") return terminal([askDate(due, run.now)]);
    const row = await createReminder(run.tx, {
      tenantId: run.ctx.tenantId,
      phoneId: run.ctx.phoneId,
      ...fields,
      dueAt: due.dueAt,
      dueDate: due.dueDate,
      timeWasDefault: due.timeWasDefault,
      sourceMessageId: run.ctx.sourceMessageDbId,
    });
    return terminal([es.reminderSaved(reminderView(row), run.now, due.timeWasDefault)]);
  },
};

/** El recordatorio del que habla: el que corrige, el de la ref, o el único. */
function targetOf(run: ToolRunCtx, ref: string): ReminderRef | null {
  const r = run.ctx.reminders;
  if (!r) return null;
  const byRef = nz(ref) ? r.open.find((o) => o.ref === ref.trim()) : undefined;
  return byRef ?? r.fixing ?? (r.open.length === 1 ? (r.open[0] ?? null) : null);
}

/** Sin saber cuál: la lista (H25) para que lo toque. */
async function whichOne(run: ToolRunCtx): Promise<ToolOutcome> {
  const r = run.ctx.reminders;
  const open = r?.open ?? [];
  return terminal([es.reminderList(open.map(reminderView), r?.pending ?? 0, run.now)]);
}

const updateReminderTool: ToolSpec<typeof UpdateReminderInput> = {
  name: "update_reminder",
  description:
    "Cambia un recordatorio que ya existe: el día o la hora ('cámbialo para el lunes a las 3 pm', 'mejor a las 4 pm'), el monto ('son 25$') o qué es ('pagar el agua'). Úsala también para lo que escribe después de tocar Corregir en un recordatorio. Solo los campos que cambian; los demás ''.",
  schema: UpdateReminderInput,
  roles: ["owner"],
  strict: false,
  async run(input, run) {
    const ref = targetOf(run, input.reminder);
    if (!ref) return whichOne(run);
    const row = await getReminder(run.tx, run.ctx.tenantId, ref.id);
    if (!row?.text || row.status === "cancelled" || row.status === "done") return whichOne(run);
    const change: ReminderChange = {};
    const text = nz(input.text);
    if (text) change.text = text.slice(0, 80);
    const amount = parseAmount(input.amount);
    if (amount) {
      change.amount = amount.toFixed(2);
      change.currency =
        input.currency === "unknown" && row.currency
          ? (row.currency as ReminderCurrency)
          : reminderCurrency(input.currency, amount, run.ctx);
    }
    const when = nz(input.when);
    if (when) {
      const due = resolveDueAt(when, run.now, dueBaseOf(row.dueAt, row.timeWasDefault));
      if (due.kind === "ambiguous_hour") {
        const draft: ReminderDraft = {
          id: row.id,
          ...change,
          hour: due.hour,
          minute: due.minute,
          date: due.date,
        };
        return terminal(
          [es.reminderAskAmPm(due.hour, due.minute)],
          [{ name: REMINDER_DRAFT, args: draft }],
        );
      }
      if (due.kind !== "ok") return terminal([askDate(due, run.now)]);
      change.dueAt = due.dueAt;
      change.dueDate = due.dueDate;
      change.timeWasDefault = due.timeWasDefault;
    }
    if (Object.keys(change).length === 0) return terminal([es.reminderFixPrompt()]);
    const saved = await updateReminder(run.tx, row, change, { phoneId: run.ctx.phoneId }, run.now);
    return terminal([es.reminderSaved(reminderView(saved), run.now, saved.timeWasDefault)]);
  },
};

const cancelReminderTool: ToolSpec<typeof CancelReminderInput> = {
  name: "cancel_reminder",
  description:
    "Borra un RECORDATORIO ('borra el recordatorio de la luz', 'ya no me recuerdes lo de Pedro', 'quita ese recordatorio'). Borrar un gasto o una venta es delete_last_movement, nunca esta.",
  schema: CancelReminderInput,
  roles: ["owner"],
  strict: false,
  async run(input, run) {
    const ref = targetOf(run, input.reminder);
    if (!ref) return whichOne(run);
    const row = await getReminder(run.tx, run.ctx.tenantId, ref.id);
    if (!row || row.status === "cancelled") return whichOne(run);
    await cancelReminder(run.tx, row, { phoneId: run.ctx.phoneId }, run.now);
    const wa = run.ctx.sourceWaMessageId;
    return terminal([
      wa
        ? { type: "reaction", body: es.REMINDER_REACTION.del, waMessageId: wa }
        : { type: "text", body: es.REMINDER_REACTION.del },
    ]);
  },
};

export const REMINDER_TOOLS = [createReminderTool, updateReminderTool, cancelReminderTool];
