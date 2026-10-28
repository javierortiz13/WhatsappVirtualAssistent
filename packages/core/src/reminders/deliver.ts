import {
  and,
  asc,
  type Db,
  eq,
  everyTenantId,
  inArray,
  isNull,
  lte,
  schema,
  type Tx,
  withTenant,
} from "@caja/db";
import { reminderView } from "../agent/reminder-tools";
import { planCapStatus } from "../billing/limits";
import { trialSpend } from "../billing/trial";
import { type GateDeny, isQuietHours, takeUnsolicitedSlot } from "../inbox/gate";
import { sendOutbound } from "../inbox/process";
import { serviceWindow } from "../inbox/window";
import { habitSettings } from "../ledger/habits";
import { type Logger, maskPhone, silentLogger } from "../log";
import { es, type Outbound } from "../render/index";
import type { MetaClient } from "../whatsapp/client";
import { EXPIRE_MS } from "./rider";
import { type ReminderRow, reminderLimits, reminderSendsThisMonth } from "./store";

/**
 * Entrega de recordatorios (PRD hábitos US-304, US-305, US-306): la cola `reminders` corre cada
 * minuto y recorre los negocios. Camino a: a su hora, con la ventana abierta. Camino b: antes de
 * que cierre la ventana, si vence después. Lo que no sale por ninguno espera al próximo mensaje
 * del dueño (camino c, en `process.ts`). Más de 7 días vencido sin entregar: `expired`.
 *
 * Un envío que Meta rechaza deja el recordatorio pendiente y el mensaje en `failed`: la puerta
 * (`failed_recent`) no vuelve a escribirle a ese teléfono en 7 días, y el camino c lo muestra
 * cuando escriba (N-4, sin un estado `failed` en la tabla).
 */
export type DeliverResult = {
  a: number;
  b: number;
  expired: number;
  failed: number;
  denied: Partial<Record<GateDeny | "send_cap", number>>;
};

/** El camino a solo toma lo que venció hace poco; lo más viejo espera al camino c (DQ-5). */
const A_LATE_MS = 10 * 60_000;
/** Camino b: el aviso adelantado sale 23 h después del último mensaje del dueño (US-305). */
const B_AFTER_MS = 23 * 3_600_000;

type Pending = {
  phoneId: string;
  e164: string;
  kind: "reminder_a" | "reminder_b";
  rows: ReminderRow[];
  out: Outbound;
};

/** Negocio que no puede recibir nada por cuenta propia: suspendido, borrado o en su tope. */
async function tenantBlocked(tx: Tx, tenantId: string, now: Date): Promise<boolean> {
  const [t] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId));
  if (!t || t.deletedAt || t.status === "suspended") return true;
  if (t.status === "trial") return (await trialSpend(tx, t)).reached;
  return Boolean((await planCapStatus(tx, t, now))?.reached);
}

/**
 * Cuándo sale el aviso adelantado: 23 h después del último mensaje. Si cae de noche (20:31 a
 * 07:59), a las 8 pm de antes; si eso ya es antes del último mensaje, no hay momento (null).
 */
export function earlyAt(lastInboundAt: Date): Date | null {
  const target = new Date(lastInboundAt.getTime() + B_AFTER_MS);
  if (!isQuietHours(target)) return target;
  const local = new Date(target.getTime() - 4 * 3_600_000);
  const day = local.getUTCHours() >= 20 ? 0 : -1;
  const eight = new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day, 20 + 4, 0),
  );
  return eight.getTime() > lastInboundAt.getTime() ? eight : null;
}

async function takeForTenant(
  tx: Tx,
  tenantId: string,
  now: Date,
  denied: DeliverResult["denied"],
): Promise<{ pending: Pending[]; expired: number }> {
  // Vencidos hace más de 7 días sin entregar.
  const expired = await tx
    .update(schema.reminder)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(schema.reminder.tenantId, tenantId),
        eq(schema.reminder.status, "pending"),
        lte(schema.reminder.dueAt, new Date(now.getTime() - EXPIRE_MS)),
      ),
    )
    .returning({ id: schema.reminder.id });
  const open = await tx
    .select()
    .from(schema.reminder)
    .where(
      and(
        eq(schema.reminder.tenantId, tenantId),
        eq(schema.reminder.status, "pending"),
        isNull(schema.reminder.deletedAt),
      ),
    )
    .orderBy(asc(schema.reminder.dueAt));
  if (!open.length) return { pending: [], expired: expired.length };
  const blocked = await tenantBlocked(tx, tenantId, now);
  const [t] = await tx
    .select({ status: schema.tenant.status, plan: schema.tenant.plan })
    .from(schema.tenant)
    .where(eq(schema.tenant.id, tenantId));
  const sendCap = reminderLimits({
    status: t?.status ?? "trial",
    plan: t?.plan ?? "personal",
  }).sends;
  let sends = await reminderSendsThisMonth(tx, tenantId, now);
  const pending: Pending[] = [];
  const phones = [...new Set(open.map((r) => r.phoneId))];
  for (const phoneId of phones) {
    const [p] = await tx
      .select({
        e164: schema.phoneNumber.e164,
        role: schema.phoneNumber.role,
        status: schema.phoneNumber.status,
      })
      .from(schema.phoneNumber)
      .where(eq(schema.phoneNumber.id, phoneId));
    // Solo al dueño que lo pidió, con su número activo.
    if (!p?.e164 || p.role !== "owner" || p.status !== "active") continue;
    const mine = open.filter((r) => r.phoneId === phoneId);
    const window = await serviceWindow(tx, phoneId, now);
    // Camino a: lo que vence ahora (los que vencen juntos van en un mensaje).
    const due = mine.filter(
      (r) => r.dueAt.getTime() <= now.getTime() && r.dueAt.getTime() > now.getTime() - A_LATE_MS,
    );
    if (due.length) {
      if (sends >= sendCap) denied.send_cap = (denied.send_cap ?? 0) + 1;
      else {
        const gate = await takeUnsolicitedSlot(tx, {
          tenantId,
          phoneId,
          kind: "reminder_a",
          now,
          tenantBlocked: blocked,
        });
        if (gate.allow) {
          pending.push({
            phoneId,
            e164: p.e164,
            kind: "reminder_a",
            rows: due,
            out: es.reminderDue(due.map(reminderView)),
          });
          await mark(
            tx,
            due.map((r) => r.id),
            { status: "delivered", deliveredVia: "a", deliveredAt: now, updatedAt: now },
          );
          sends += 1;
          continue;
        }
        denied[gate.reason] = (denied[gate.reason] ?? 0) + 1;
      }
    }
    // Camino b: vencen después de que cierre la ventana (hasta 7 días más), sin aviso todavía.
    if (!window.lastInboundAt || !window.closesAt) continue;
    const closes = window.closesAt.getTime();
    const later = mine.filter(
      (r) =>
        !r.earlySentAt &&
        r.dueAt.getTime() > now.getTime() &&
        r.dueAt.getTime() > closes &&
        r.dueAt.getTime() <= closes + EXPIRE_MS,
    );
    const at = earlyAt(window.lastInboundAt);
    if (!later.length || !at || at.getTime() > now.getTime()) continue;
    if (sends >= sendCap) {
      denied.send_cap = (denied.send_cap ?? 0) + 1;
      continue;
    }
    const gate = await takeUnsolicitedSlot(tx, {
      tenantId,
      phoneId,
      kind: "reminder_b",
      now,
      tenantBlocked: blocked,
    });
    if (!gate.allow) {
      denied[gate.reason] = (denied[gate.reason] ?? 0) + 1;
      continue;
    }
    pending.push({
      phoneId,
      e164: p.e164,
      kind: "reminder_b",
      rows: later,
      out: es.reminderEarly(later.map(reminderView), now),
    });
    await mark(
      tx,
      later.map((r) => r.id),
      { earlySentAt: now, updatedAt: now },
    );
    sends += 1;
  }
  return { pending, expired: expired.length };
}

async function mark(
  tx: Tx,
  ids: string[],
  set: Partial<typeof schema.reminder.$inferInsert>,
): Promise<void> {
  await tx.update(schema.reminder).set(set).where(inArray(schema.reminder.id, ids));
}

/**
 * Un minuto de la cola `reminders`. Se marca y se confirma primero, se envía después (como el
 * ciclo de la prueba): un fallo de Meta no repite el mensaje; deshace la marca y queda `failed`.
 */
export async function deliverReminders(
  db: Db,
  meta: MetaClient | null,
  opts: { now: Date; log?: Logger },
): Promise<DeliverResult> {
  const log = opts.log ?? silentLogger;
  const now = opts.now;
  const result: DeliverResult = { a: 0, b: 0, expired: 0, failed: 0, denied: {} };
  if (!meta || !(await habitSettings(db)).reminders) return result;
  for (const tenantId of await everyTenantId(db)) {
    try {
      const { pending, expired } = await withTenant(db, tenantId, (tx) =>
        takeForTenant(tx, tenantId, now, result.denied),
      );
      result.expired += expired;
      for (const p of pending) {
        const ids = p.rows.map((r) => r.id);
        const record = (status: "ok" | "failed", waMessageId: string | null) =>
          withTenant(db, tenantId, (tx) =>
            tx.insert(schema.message).values({
              tenantId,
              phoneId: p.phoneId,
              direction: "out",
              kind: p.out.type,
              body: p.out.type === "reaction" ? null : p.out.body,
              status,
              waMessageId,
              // Solo los ids: el texto del recordatorio no va en las marcas (F3-4 (5)).
              toolCalls: [{ name: p.kind, args: { ids } }],
            }),
          );
        try {
          const r = await sendOutbound(meta, p.e164, p.out);
          await record("ok", r.waMessageId);
          if (p.kind === "reminder_a") result.a += 1;
          else result.b += 1;
        } catch (err) {
          result.failed += 1;
          await record("failed", null);
          // Vuelve a pendiente: el camino c lo muestra cuando escriba (N-4).
          await withTenant(db, tenantId, (tx) =>
            p.kind === "reminder_a"
              ? mark(tx, ids, {
                  status: "pending",
                  deliveredVia: null,
                  deliveredAt: null,
                  updatedAt: now,
                })
              : mark(tx, ids, { earlySentAt: null, updatedAt: now }),
          );
          log.warn(
            {
              err: err instanceof Error ? err.message : String(err),
              to: maskPhone(p.e164),
              kind: p.kind,
            },
            "recordatorio no enviado",
          );
        }
      }
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "recordatorios");
    }
  }
  return result;
}
