import { and, asc, eq, gt, gte, inArray, lte, schema, sql, type Tx } from "@caja/db";
import { reminderView } from "../agent/reminder-tools";
import { caracasMonth } from "../billing/usage";
import { habitSettings } from "../ledger/habits";
import { es } from "../render/index";
import { reminderLimits, reminderSendsThisMonth } from "./store";

/** Camino c: vencido hace más de esto sin entregar → `expired` (US-306). */
export const EXPIRE_MS = 7 * 86_400_000;

/**
 * Camino c (US-306): los recordatorios vencidos sin entregar de este dueño, arriba de su próxima
 * respuesta (`commit` los marca entregados por c). Con el tope de envíos del mes pasado, H28b va una vez al
 * mes arriba de todo. Devuelve las líneas y las marcas; null si no hay nada.
 */
export async function pendingRider(
  tx: Tx,
  c: { tenantId: string; phoneId: string; now: Date },
): Promise<{
  lines: string;
  marks: { name: string; args: unknown }[];
  /** Marca los recordatorios como entregados por c: solo si las líneas entraron en la respuesta. */
  commit: () => Promise<void>;
} | null> {
  if (!(await habitSettings(tx)).reminders) return null;
  const rows = await tx
    .select()
    .from(schema.reminder)
    .where(
      and(
        eq(schema.reminder.tenantId, c.tenantId),
        eq(schema.reminder.phoneId, c.phoneId),
        eq(schema.reminder.status, "pending"),
        lte(schema.reminder.dueAt, c.now),
        gt(schema.reminder.dueAt, new Date(c.now.getTime() - EXPIRE_MS)),
      ),
    )
    .orderBy(asc(schema.reminder.dueAt));
  const parts: string[] = [];
  const marks: { name: string; args: unknown }[] = [];
  const [t] = await tx
    .select({ status: schema.tenant.status, plan: schema.tenant.plan })
    .from(schema.tenant)
    .where(eq(schema.tenant.id, c.tenantId));
  const limits = reminderLimits({ status: t?.status ?? "trial", plan: t?.plan ?? "personal" });
  const month = caracasMonth(c.now).key;
  const sends = await reminderSendsThisMonth(tx, c.tenantId, c.now);
  if (rows.length && sends >= limits.sends && !(await capToldThisMonth(tx, c.tenantId, c.now))) {
    parts.push(es.reminderSendCapLine(sends, t?.status === "trial"));
    marks.push({ name: "reminder_send_cap", args: { month } });
  }
  if (!rows.length) return null;
  parts.push(es.reminderPendingLines(rows.map(reminderView), c.now));
  const ids = rows.map((r) => r.id);
  marks.push({ name: "reminder_c", args: { ids } });
  return {
    lines: parts.join("\n\n"),
    marks,
    commit: async () => {
      await tx
        .update(schema.reminder)
        .set({ status: "delivered", deliveredVia: "c", deliveredAt: c.now, updatedAt: c.now })
        .where(inArray(schema.reminder.id, ids));
    },
  };
}

async function capToldThisMonth(tx: Tx, tenantId: string, now: Date): Promise<boolean> {
  const { start } = caracasMonth(now);
  const [hit] = await tx
    .select({ id: schema.message.id })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.tenantId, tenantId),
        eq(schema.message.direction, "out"),
        gte(schema.message.createdAt, start),
        sql`${schema.message.toolCalls} @> '[{"name": "reminder_send_cap"}]'::jsonb`,
      ),
    )
    .limit(1);
  return Boolean(hit);
}
