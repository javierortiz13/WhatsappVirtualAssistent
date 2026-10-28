import { and, desc, eq, gt, schema, sql, type Tx } from "@caja/db";
import { REMINDER_DRAFT, type ReminderDraft, reminderView } from "../agent/reminder-tools";
import type { AgentReminders, ReminderRef } from "../agent/types";
import {
  businessDateOf,
  caracasInstant,
  type DueAt,
  dueAtOn,
  type IsoDate,
  isIsoDate,
} from "../domain/dates";
import { habitSettings } from "../ledger/habits";
import { es, type Outbound, type ReminderAction } from "../render/index";
import {
  cancelReminder,
  createReminder,
  getReminder,
  markReminderDone,
  openReminders,
  pendingCount,
  type ReminderChange,
  reminderLimits,
  snoozeReminder,
  updateReminder,
} from "./store";

/**
 * Recordatorios en el chat sin la IA (PRD hábitos US-303, US-308): los toques de sus botones,
 * «mis recordatorios» y el contexto que necesita el agente. Los toques funcionan aunque el
 * interruptor se apague: borrar o marcar uno nunca debe quedar bloqueado.
 */
export type ReminderChatCtx = {
  tenantId: string;
  phoneId: string;
  role: "owner" | "employee";
  /** wa_message_id del mensaje entrante, para la reacción. */
  inboundId: string;
  now: Date;
};

export type ReminderReply = { outbound: Outbound[]; toolCalls: { name: string; args: unknown }[] };

/** Marca de la respuesta a Corregir (H15b): el próximo texto corrige ese recordatorio. */
export const REMINDER_FIX = "reminder_fix";
const FIX_WINDOW_MS = 30 * 60_000;
const DRAFT_WINDOW_MS = 2 * 3_600_000;

const reply = (out: Outbound, toolCalls: ReminderReply["toolCalls"] = []): ReminderReply => ({
  outbound: [out],
  toolCalls,
});

/** «mis recordatorios», «recordatorios», «qué tengo pendiente» (US-308), el mensaje entero. */
export function isReminderListAsk(text: string): boolean {
  const t = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[¿?¡!.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(ver |mis |ver mis )?recordatorios$|^que tengo pendientes?$/.test(t);
}

/** La última marca `name` que mandó el bot a este teléfono, si es reciente. */
async function lastMarker(
  tx: Tx,
  phoneId: string,
  name: string,
  since: Date,
): Promise<{ args: Record<string, unknown>; latest: boolean } | null> {
  const [row] = await tx
    .select({ id: schema.message.id, toolCalls: schema.message.toolCalls })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.phoneId, phoneId),
        eq(schema.message.direction, "out"),
        gt(schema.message.createdAt, since),
        sql`${schema.message.toolCalls} @> ${JSON.stringify([{ name }])}::jsonb`,
      ),
    )
    .orderBy(desc(schema.message.createdAt))
    .limit(1);
  if (!row) return null;
  const call = (row.toolCalls as { name: string; args?: Record<string, unknown> }[]).find(
    (c) => c.name === name,
  );
  const [last] = await tx
    .select({ id: schema.message.id })
    .from(schema.message)
    .where(and(eq(schema.message.phoneId, phoneId), eq(schema.message.direction, "out")))
    .orderBy(desc(schema.message.createdAt))
    .limit(1);
  return { args: call?.args ?? {}, latest: last?.id === row.id };
}

async function limitsOf(tx: Tx, tenantId: string) {
  const [t] = await tx
    .select({ status: schema.tenant.status, plan: schema.tenant.plan })
    .from(schema.tenant)
    .where(eq(schema.tenant.id, tenantId));
  const status = t?.status ?? "trial";
  return { ...reminderLimits({ status, plan: t?.plan ?? "personal" }), trial: status === "trial" };
}

/** Lo que el agente sabe de los recordatorios; undefined con el interruptor apagado. */
export async function reminderAgentContext(
  tx: Tx,
  c: Omit<ReminderChatCtx, "inboundId">,
): Promise<AgentReminders | undefined> {
  if (!(await habitSettings(tx)).reminders) return undefined;
  // Un empleado nunca carga los recordatorios (F3-5): solo la herramienta, que le responde H29.
  if (c.role !== "owner") return { open: [], fixing: null, pending: 0, limit: 0, trial: false };
  const rows = await openReminders(tx, c.tenantId, 10);
  const open: ReminderRef[] = rows.map((r, i) => ({
    ref: `r${i + 1}`,
    id: r.id,
    text: r.text,
    kind: r.kind as ReminderRef["kind"],
    amount: r.amount,
    currency: r.currency as ReminderRef["currency"],
    counterparty: r.counterparty,
    dueAt: r.dueAt,
    timeWasDefault: r.timeWasDefault,
  }));
  let fixing: ReminderRef | null = null;
  const fix = await lastMarker(
    tx,
    c.phoneId,
    REMINDER_FIX,
    new Date(c.now.getTime() - FIX_WINDOW_MS),
  );
  if (fix?.latest && typeof fix.args.id === "string") {
    const row = await getReminder(tx, c.tenantId, fix.args.id);
    if (row?.text && row.status !== "cancelled" && row.status !== "done")
      fixing = open.find((o) => o.id === row.id) ?? {
        ref: "r0",
        id: row.id,
        text: row.text,
        kind: row.kind as ReminderRef["kind"],
        amount: row.amount,
        currency: row.currency as ReminderRef["currency"],
        counterparty: row.counterparty,
        dueAt: row.dueAt,
        timeWasDefault: row.timeWasDefault,
      };
  }
  const limits = await limitsOf(tx, c.tenantId);
  return {
    open,
    fixing,
    pending: await pendingCount(tx, c.tenantId),
    limit: limits.pending,
    trial: limits.trial,
  };
}

/** H25 / H27. */
export async function reminderListReply(tx: Tx, c: ReminderChatCtx): Promise<ReminderReply> {
  if (c.role !== "owner") return reply(es.reminderEmployee());
  const rows = await openReminders(tx, c.tenantId, 10);
  const total = await pendingCount(tx, c.tenantId);
  return reply(es.reminderList(rows.map(reminderView), total, c.now), [
    { name: "reminder_list", args: { n: total } },
  ]);
}

const reaction = (c: ReminderChatCtx, emoji: string): Outbound => ({
  type: "reaction",
  body: emoji,
  waMessageId: c.inboundId,
});

/** Toques de `rem:<acción>:<id>` (H16, H21, H25, H26). */
export async function reminderTap(
  tx: Tx,
  c: ReminderChatCtx,
  action: ReminderAction,
  id: string,
): Promise<ReminderReply> {
  if (c.role !== "owner") return reply(es.reminderEmployee());
  const row = await getReminder(tx, c.tenantId, id);
  const mark = [{ name: "reminder_tap", args: { action } }];
  const closed = !row || row.status === "cancelled" || row.status === "done";
  const actor = { phoneId: c.phoneId };
  switch (action) {
    case "del":
      if (row && row.status !== "cancelled") await cancelReminder(tx, row, actor, c.now);
      return reply(reaction(c, es.REMINDER_REACTION.del), mark);
    case "done":
      if (row && !closed) await markReminderDone(tx, row, actor, c.now);
      return reply(reaction(c, es.REMINDER_REACTION.done), mark);
    case "snooze":
      if (!row || closed) return reminderListReply(tx, c);
      await snoozeReminder(tx, row, actor, c.now);
      return reply(reaction(c, es.REMINDER_REACTION.snooze), mark);
    case "fix":
      if (!row || closed) return reminderListReply(tx, c);
      return reply(es.reminderFixPrompt(), [{ name: REMINDER_FIX, args: { id: row.id } }]);
    case "open":
      if (!row || closed) return reminderListReply(tx, c);
      return reply(es.reminderDetail(reminderView(row), c.now));
  }
}

/** H18–H18d para lo que no se pudo ubicar. */
function askDate(due: Exclude<DueAt, { kind: "ok" | "ambiguous_hour" }>, now: Date): Outbound {
  if (due.kind === "hour_passed")
    return es.reminderAskDate(
      "hour_passed",
      caracasInstant(businessDateOf(now), due.hour, due.minute),
    );
  return es.reminderAskDate(due.kind);
}

/** H17 respondida: «9 de la mañana» / «9 de la noche» termina el recordatorio sin la IA. */
export async function reminderAmPm(
  tx: Tx,
  c: ReminderChatCtx,
  half: "am" | "pm",
): Promise<ReminderReply> {
  if (c.role !== "owner") return reply(es.reminderEmployee());
  const found = await lastMarker(
    tx,
    c.phoneId,
    REMINDER_DRAFT,
    new Date(c.now.getTime() - DRAFT_WINDOW_MS),
  );
  if (!found) return reply(es.reminderAskDate("no_date"));
  // Solo la pregunta más reciente: un segundo toque sobre la misma no crea otro igual.
  if (!found.latest) return reminderListReply(tx, c);
  const d = found.args as ReminderDraft;
  const hour = half === "pm" ? (d.hour < 12 ? d.hour + 12 : d.hour) : d.hour === 12 ? 0 : d.hour;
  const day: IsoDate = d.date && isIsoDate(d.date) ? d.date : businessDateOf(c.now);
  const due = dueAtOn(day, hour, d.minute, c.now, false);
  if (due.kind !== "ok") return reply(askDate(due as Exclude<DueAt, { kind: "ok" }>, c.now));
  const actor = { phoneId: c.phoneId };
  const done = [{ name: "reminder_ampm", args: { half } }];
  if (d.id) {
    const row = await getReminder(tx, c.tenantId, d.id);
    if (!row?.text || row.status === "cancelled" || row.status === "done")
      return reminderListReply(tx, c);
    const change: ReminderChange = {
      ...(d.text ? { text: d.text } : {}),
      ...(d.amount ? { amount: d.amount, currency: d.currency ?? null } : {}),
      dueAt: due.dueAt,
      dueDate: due.dueDate,
      timeWasDefault: false,
    };
    const saved = await updateReminder(tx, row, change, actor, c.now);
    return reply(es.reminderSaved(reminderView(saved), c.now, false), done);
  }
  if (!d.text || !d.kind) return reply(es.reminderAskDate("no_date"));
  // El tope se mira otra vez: entre la pregunta y el toque pudo crear otros.
  const limits = await limitsOf(tx, c.tenantId);
  const n = await pendingCount(tx, c.tenantId);
  if (n >= limits.pending)
    return reply(es.reminderLimit(n, limits.trial), [
      { name: "reminder_rejected", args: { reason: "limit" } },
    ]);
  const row = await createReminder(tx, {
    tenantId: c.tenantId,
    phoneId: c.phoneId,
    text: d.text,
    kind: d.kind,
    amount: d.amount ?? null,
    currency: d.currency ?? null,
    counterparty: d.counterparty ?? null,
    dueAt: due.dueAt,
    dueDate: due.dueDate,
    timeWasDefault: false,
    sourceMessageId: null,
  });
  return reply(es.reminderSaved(reminderView(row), c.now, false), done);
}
