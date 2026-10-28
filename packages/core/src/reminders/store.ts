import { and, asc, eq, gte, inArray, isNull, schema, sql, type Tx } from "@caja/db";
import { caracasMonth } from "../billing/usage";
import { addDays, businessDateOf, caracasInstant, dueBaseOf, type IsoDate } from "../domain/dates";

/**
 * Recordatorios de plata (PRD hábitos P3, §6). Solo el dueño los crea y los recibe. El texto, el
 * monto y la contraparte son de terceros a veces (F3-4): se borran al tocar Borrar, nunca salen en
 * logs, métricas ni /admin, y la auditoría guarda solo los nombres de los campos.
 */
export type ReminderKind = "pay" | "collect" | "other_money";
export type ReminderCurrency = "USD" | "VES" | "EUR";
export type ReminderRow = typeof schema.reminder.$inferSelect;

/** Límites por plan (§6.5): pendientes a la vez, mensajes de recordatorio al mes, plantillas. */
export const REMINDER_LIMITS: Record<
  string,
  { pending: number; sends: number; templates: number }
> = {
  trial: { pending: 5, sends: 30, templates: 0 },
  personal: { pending: 10, sends: 30, templates: 5 },
  negocio: { pending: 20, sends: 60, templates: 5 },
  negocio_plus: { pending: 40, sends: 120, templates: 5 },
};

export function reminderLimits(t: { status: string; plan: string }) {
  if (t.status === "trial") return REMINDER_LIMITS.trial as (typeof REMINDER_LIMITS)[string];
  return (REMINDER_LIMITS[t.plan] ?? REMINDER_LIMITS.personal) as (typeof REMINDER_LIMITS)[string];
}

async function audit(
  tx: Tx,
  r: { tenantId: string; id: string },
  action: string,
  fields: string[],
  actor: { phoneId?: string; userId?: string },
  channel: "whatsapp" | "dashboard" | "system",
): Promise<void> {
  await tx.insert(schema.auditLog).values({
    tenantId: r.tenantId,
    actorType: actor.phoneId ? "phone" : actor.userId ? "user" : "system",
    actorId: actor.phoneId ?? actor.userId ?? null,
    action,
    entity: "reminder",
    entityId: r.id,
    // Solo los nombres de los campos, nunca los valores (F3-4 (3)).
    after: { fields },
    channel,
  });
}

/** Pendientes para el dueño: los que esperan su hora y los entregados sin marcar (H25, H28). */
export async function pendingCount(tx: Tx, tenantId: string): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.reminder)
    .where(
      and(
        eq(schema.reminder.tenantId, tenantId),
        inArray(schema.reminder.status, ["pending", "delivered"]),
        isNull(schema.reminder.doneAt),
      ),
    );
  return r?.n ?? 0;
}

export type NewReminder = {
  tenantId: string;
  phoneId: string;
  text: string;
  kind: ReminderKind;
  amount: string | null;
  currency: ReminderCurrency | null;
  counterparty: string | null;
  dueAt: Date;
  dueDate: IsoDate;
  timeWasDefault: boolean;
  sourceMessageId: string | null;
};

export async function createReminder(tx: Tx, r: NewReminder): Promise<ReminderRow> {
  const [row] = await tx
    .insert(schema.reminder)
    .values({
      tenantId: r.tenantId,
      phoneId: r.phoneId,
      text: r.text.slice(0, 80),
      kind: r.kind,
      amount: r.amount,
      currency: r.amount ? r.currency : null,
      counterparty: r.counterparty?.slice(0, 40) ?? null,
      dueAt: r.dueAt,
      dueDate: r.dueDate,
      timeWasDefault: r.timeWasDefault,
      sourceMessageId: r.sourceMessageId,
    })
    .returning();
  if (!row) throw new Error("no se pudo guardar el recordatorio");
  await audit(
    tx,
    row,
    "reminder_create",
    ["text", "kind", "due_at"],
    { phoneId: r.phoneId },
    "whatsapp",
  );
  return row;
}

export async function getReminder(
  tx: Tx,
  tenantId: string,
  id: string,
): Promise<ReminderRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await tx
    .select()
    .from(schema.reminder)
    .where(and(eq(schema.reminder.tenantId, tenantId), eq(schema.reminder.id, id)));
  return row ?? null;
}

/** Pendientes y entregados sin hacer, del más próximo al más lejano. */
export async function openReminders(tx: Tx, tenantId: string, limit = 50): Promise<ReminderRow[]> {
  return tx
    .select()
    .from(schema.reminder)
    .where(
      and(
        eq(schema.reminder.tenantId, tenantId),
        inArray(schema.reminder.status, ["pending", "delivered"]),
        isNull(schema.reminder.doneAt),
      ),
    )
    .orderBy(asc(schema.reminder.dueAt))
    .limit(limit);
}

export type ReminderChange = Partial<{
  text: string;
  kind: ReminderKind;
  amount: string | null;
  currency: ReminderCurrency | null;
  counterparty: string | null;
  dueAt: Date;
  dueDate: IsoDate;
  timeWasDefault: boolean;
}>;

/** Corregir (US-303, US-308): cambia lo que dijo y lo deja pendiente otra vez. */
export async function updateReminder(
  tx: Tx,
  r: ReminderRow,
  change: ReminderChange,
  actor: { phoneId?: string; userId?: string },
  now: Date,
  channel: "whatsapp" | "dashboard" = "whatsapp",
): Promise<ReminderRow> {
  const fields = Object.keys(change).map((k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
  const due = change.dueAt !== undefined;
  const [row] = await tx
    .update(schema.reminder)
    .set({
      ...change,
      ...(change.text !== undefined ? { text: change.text.slice(0, 80) } : {}),
      ...(change.counterparty ? { counterparty: change.counterparty.slice(0, 40) } : {}),
      // Con otra fecha vuelve a esperar su hora (y su aviso adelantado).
      ...(due
        ? { status: "pending", earlySentAt: null, deliveredAt: null, deliveredVia: null }
        : {}),
      updatedAt: now,
    })
    .where(eq(schema.reminder.id, r.id))
    .returning();
  if (!row) throw new Error("recordatorio no encontrado");
  await audit(tx, row, "reminder_update", fields, actor, channel);
  return row;
}

/** Borrar (F3-4 (1)): cancelado, y el texto, el monto y la contraparte se borran ya. */
export async function cancelReminder(
  tx: Tx,
  r: ReminderRow,
  actor: { phoneId?: string; userId?: string },
  now: Date,
  channel: "whatsapp" | "dashboard" = "whatsapp",
): Promise<void> {
  await tx
    .update(schema.reminder)
    .set({
      status: "cancelled",
      text: null,
      amount: null,
      currency: null,
      counterparty: null,
      deletedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.reminder.id, r.id));
  await audit(tx, r, "reminder_cancel", ["status"], actor, channel);
}

export async function markReminderDone(
  tx: Tx,
  r: ReminderRow,
  actor: { phoneId?: string; userId?: string },
  now: Date,
  linkedMovementId: string | null = null,
  channel: "whatsapp" | "dashboard" = "whatsapp",
): Promise<void> {
  await tx
    .update(schema.reminder)
    .set({
      status: "done",
      doneAt: now,
      updatedAt: now,
      ...(linkedMovementId ? { linkedMovementId } : {}),
    })
    .where(eq(schema.reminder.id, r.id));
  await audit(
    tx,
    r,
    "reminder_done",
    linkedMovementId ? ["status", "linked_movement_id"] : ["status"],
    actor,
    channel,
  );
}

/**
 * «Recuérdame mañana»: un día después, a la misma hora. Si el aviso llegó tarde (camino c), cuenta
 * desde hoy: un día más sobre la fecha original podría ser ya pasado.
 */
export async function snoozeReminder(
  tx: Tx,
  r: ReminderRow,
  actor: { phoneId?: string },
  now: Date,
): Promise<ReminderRow> {
  const base = dueBaseOf(r.dueAt, r.timeWasDefault);
  const today = businessDateOf(now);
  // Un día después de su fecha, y nunca antes de mañana.
  const dueDate = addDays(base.date > today ? base.date : today, 1);
  const dueAt = caracasInstant(dueDate, base.hour, base.minute);
  return updateReminder(tx, r, { dueAt, dueDate }, actor, now);
}

/** Mensajes de recordatorio de este mes (camino a y b), para el tope del plan (§6.5). */
export async function reminderSendsThisMonth(tx: Tx, tenantId: string, now: Date): Promise<number> {
  const { start } = caracasMonth(now);
  const [r] = await tx
    .select({
      n: sql<number>`count(distinct coalesce(${schema.message.webhookEventId}, ${schema.message.id}))::int`,
    })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.tenantId, tenantId),
        eq(schema.message.direction, "out"),
        gte(schema.message.createdAt, start),
        sql`(${schema.message.toolCalls} @> '[{"name": "reminder_a"}]'::jsonb or ${schema.message.toolCalls} @> '[{"name": "reminder_b"}]'::jsonb)`,
      ),
    );
  return r?.n ?? 0;
}

export type DashboardReminder = ReminderRow & { movementType: string | null };

/**
 * La página Recordatorios (US-309, H32): los pendientes (esperando su hora o avisados sin marcar)
 * y los hechos o vencidos de los últimos 30 días. Los borrados no salen: ya no tienen texto.
 */
export async function dashboardReminders(
  tx: Tx,
  tenantId: string,
  now: Date,
): Promise<{ pending: DashboardReminder[]; history: DashboardReminder[] }> {
  const rows = await tx
    .select({ r: schema.reminder, movementType: schema.movement.type })
    .from(schema.reminder)
    .leftJoin(
      schema.movement,
      and(
        eq(schema.movement.id, schema.reminder.linkedMovementId),
        isNull(schema.movement.deletedAt),
      ),
    )
    .where(
      and(
        eq(schema.reminder.tenantId, tenantId),
        inArray(schema.reminder.status, ["pending", "delivered", "done", "expired"]),
        gte(schema.reminder.updatedAt, new Date(now.getTime() - 400 * 86_400_000)),
      ),
    )
    .orderBy(asc(schema.reminder.dueAt));
  const all = rows.map(({ r, movementType }) => ({ ...r, movementType }));
  const since = now.getTime() - 30 * 86_400_000;
  return {
    pending: all.filter((r) => (r.status === "pending" || r.status === "delivered") && !r.doneAt),
    history: all
      .filter(
        (r) => (r.status === "done" || r.status === "expired") && r.updatedAt.getTime() >= since,
      )
      .reverse(),
  };
}
