import { and, eq, schema, type Tx } from "@caja/db";
import { type Decimal, toDbAmount, toDbRate } from "../domain/money";
import { PERIOD_DAYS, type PlanId, RECHARGE } from "./plans";
import type { BillingMethod, BillingRateKind } from "./pricing";
import { extendPaidUntil } from "./subscription";
import { caracasMonth } from "./usage";

/**
 * Pagos verificados a mano (fase 1). El administrador registra el pago que el cliente le
 * reportó; al aprobarlo el negocio pasa a activo, toma el plan pagado y su vigencia se extiende
 * 30 días por mes pagado. Todo corre dentro de `withTenant` del negocio y queda en auditoría.
 */
export type Reviewer = { userId: string; email: string };
/** Quién reporta un pago: el dueño en el dashboard (usuario) o por WhatsApp (teléfono). */
export type Reporter = Reviewer | { phoneId: string };

export type NewPayment = {
  tenantId: string;
  plan: PlanId;
  months: number;
  method: BillingMethod;
  amount: Decimal;
  currency: "VES" | "USD" | "USDT";
  rateKind: BillingRateKind | "manual" | null;
  rateValue: Decimal | null;
  amountUsd: Decimal;
  reference: string | null;
  notes: string | null;
  /** Plan (por defecto) o recarga de mensajes del mes (0019). */
  kind?: "plan" | "recharge" | undefined;
};

export async function recordPayment(
  tx: Tx,
  p: NewPayment,
  reviewer: Reviewer,
  now: Date,
  opts: { approve: boolean },
): Promise<{ paymentId: string; paidUntil: Date | null }> {
  if (!p.amount.isFinite() || p.amount.lte(0)) throw new Error("monto inválido");
  if (!Number.isInteger(p.months) || p.months < 1 || p.months > 12)
    throw new Error("meses inválidos");
  const [row] = await tx
    .insert(schema.payment)
    .values({
      tenantId: p.tenantId,
      plan: p.plan,
      months: p.months,
      method: p.method,
      amount: toDbAmount(p.amount),
      currency: p.currency,
      rateKind: p.rateKind,
      rateValue: p.rateValue ? toDbRate(p.rateValue) : null,
      amountUsd: toDbAmount(p.amountUsd),
      reference: p.reference,
      notes: p.notes,
      kind: p.kind ?? "plan",
    })
    .returning({ id: schema.payment.id });
  if (!row) throw new Error("no se pudo registrar el pago");
  await audit(tx, p.tenantId, reviewer, "create", "payment", row.id, null, { ...p }, now);
  if (!opts.approve) return { paymentId: row.id, paidUntil: null };
  const { paidUntil } = await approvePayment(tx, p.tenantId, row.id, reviewer, now);
  return { paymentId: row.id, paidUntil };
}

/**
 * El cliente reporta un pago que hizo, desde "Mi plan" (02/10/2026) o por WhatsApp (03/10). Queda
 * pendiente: solo el administrador lo aprueba después de verificarlo en su banco o billetera.
 */
export async function reportPayment(
  tx: Tx,
  p: NewPayment,
  reporter: Reporter,
  now: Date,
): Promise<{ paymentId: string }> {
  if (!p.amount.isFinite() || p.amount.lte(0)) throw new Error("monto inválido");
  if (!Number.isInteger(p.months) || p.months < 1 || p.months > 12)
    throw new Error("meses inválidos");
  const open = await tx
    .select({ id: schema.payment.id })
    .from(schema.payment)
    .where(and(eq(schema.payment.tenantId, p.tenantId), eq(schema.payment.status, "pending")));
  if (open.length >= 3) throw new TooManyPendingError();
  const [row] = await tx
    .insert(schema.payment)
    .values({
      tenantId: p.tenantId,
      plan: p.plan,
      months: p.months,
      method: p.method,
      amount: toDbAmount(p.amount),
      currency: p.currency,
      rateKind: p.rateKind,
      rateValue: p.rateValue ? toDbRate(p.rateValue) : null,
      amountUsd: toDbAmount(p.amountUsd),
      reference: p.reference,
      notes: p.notes,
      kind: p.kind ?? "plan",
    })
    .returning({ id: schema.payment.id });
  if (!row) throw new Error("no se pudo registrar el pago");
  await audit(
    tx,
    p.tenantId,
    reporter,
    "report",
    "payment",
    row.id,
    null,
    { ...p },
    now,
    "phoneId" in reporter ? "whatsapp" : "dashboard",
  );
  return { paymentId: row.id };
}

/** Tope de pagos por verificar por negocio, para que un error de la página no llene la cola. */
export class TooManyPendingError extends Error {
  constructor() {
    super("ya hay 3 pagos por verificar");
    this.name = "TooManyPendingError";
  }
}

export async function approvePayment(
  tx: Tx,
  tenantId: string,
  paymentId: string,
  reviewer: Reviewer,
  now: Date,
): Promise<{ paidUntil: Date }> {
  // El negocio se bloquea primero: dos aprobaciones a la vez calcularían la vigencia desde el
  // mismo paid_until y se perdería un pago; y un rechazo simultáneo pisaría la aprobación.
  const [t] = await tx
    .select()
    .from(schema.tenant)
    .where(eq(schema.tenant.id, tenantId))
    .for("update");
  if (!t) throw new Error("negocio no encontrado");
  const [pay] = await tx
    .select()
    .from(schema.payment)
    .where(and(eq(schema.payment.id, paymentId), eq(schema.payment.tenantId, tenantId)))
    .for("update");
  if (!pay) throw new Error("pago no encontrado");
  if (pay.status !== "pending") throw new Error(`el pago ya está ${pay.status}`);
  if (pay.kind === "recharge") return approveRecharge(tx, t, pay.id, reviewer, now);
  const paidUntil = extendPaidUntil(t, pay.months, now, PERIOD_DAYS);
  const done = await tx
    .update(schema.payment)
    .set({ status: "approved", reviewedBy: reviewer.email, reviewedAt: now })
    .where(and(eq(schema.payment.id, pay.id), eq(schema.payment.status, "pending")))
    .returning({ id: schema.payment.id });
  if (done.length === 0) throw new Error("el pago ya fue revisado");
  await setTenantBilling(
    tx,
    t,
    { status: "active", plan: pay.plan, paidUntil },
    reviewer,
    now,
    "approve_payment",
  );
  return { paidUntil };
}

/**
 * Recarga aprobada (0019): +100 mensajes que valen hasta fin de mes. Si la recarga anterior era
 * de otro mes, se empieza de cero. No toca el plan ni la vigencia.
 */
async function approveRecharge(
  tx: Tx,
  t: typeof schema.tenant.$inferSelect,
  paymentId: string,
  reviewer: Reviewer,
  now: Date,
): Promise<{ paidUntil: Date }> {
  const done = await tx
    .update(schema.payment)
    .set({ status: "approved", reviewedBy: reviewer.email, reviewedAt: now })
    .where(and(eq(schema.payment.id, paymentId), eq(schema.payment.status, "pending")))
    .returning({ id: schema.payment.id });
  if (done.length === 0) throw new Error("el pago ya fue revisado");
  await addExtraMessages(tx, t, RECHARGE.messages, reviewer, now, "approve_recharge");
  return { paidUntil: t.paidUntil ?? now };
}

/**
 * Suma mensajes extra al mes en curso (recarga pagada o regalo del administrador). Los de un mes
 * anterior no se acumulan. Devuelve el total extra del mes.
 */
export async function addExtraMessages(
  tx: Tx,
  t: typeof schema.tenant.$inferSelect,
  messages: number,
  actor: Reviewer,
  now: Date,
  reason: "approve_recharge" | "admin_gift",
): Promise<number> {
  const month = caracasMonth(now).key;
  const before = t.extraMonth === month ? t.extraMessages : 0;
  const after = Math.max(0, before + messages);
  await tx
    .update(schema.tenant)
    .set({ extraMessages: after, extraMonth: month, updatedAt: now })
    .where(eq(schema.tenant.id, t.id));
  await audit(
    tx,
    t.id,
    actor,
    "update",
    "tenant",
    t.id,
    { extraMessages: before },
    { extraMessages: after, extraMonth: month, reason },
    now,
  );
  return after;
}

export async function rejectPayment(
  tx: Tx,
  tenantId: string,
  paymentId: string,
  reviewer: Reviewer,
  reason: string | null,
  now: Date,
): Promise<void> {
  const [pay] = await tx
    .select()
    .from(schema.payment)
    .where(and(eq(schema.payment.id, paymentId), eq(schema.payment.tenantId, tenantId)));
  if (!pay) throw new Error("pago no encontrado");
  if (pay.status !== "pending") throw new Error(`el pago ya está ${pay.status}`);
  // Solo si sigue pendiente: si otra pestaña lo aprobó, el rechazo no pisa la aprobación.
  const done = await tx
    .update(schema.payment)
    .set({ status: "rejected", reviewedBy: reviewer.email, reviewedAt: now, notes: reason })
    .where(and(eq(schema.payment.id, pay.id), eq(schema.payment.status, "pending")))
    .returning({ id: schema.payment.id });
  if (done.length === 0) throw new Error("el pago ya fue revisado");
  await audit(tx, tenantId, reviewer, "reject", "payment", pay.id, null, { reason }, now);
}

/** Cambios del administrador sin pago: plan, extender, cortesía, suspender o reactivar. */
export type TenantBillingChange = {
  status?: "trial" | "active" | "suspended";
  plan?: string;
  paidUntil?: Date | null;
  trialEndsAt?: Date | null;
  /** Tope de gasto de la prueba (0016); null = el del plan. */
  trialBudgetUsd?: string | null;
  trialCapNotifiedAt?: Date | null;
};

export async function setTenantBilling(
  tx: Tx,
  before: typeof schema.tenant.$inferSelect,
  change: TenantBillingChange,
  actor: Reviewer | null,
  now: Date,
  action: string,
): Promise<void> {
  // 0017: los datos de un suspendido se guardan 90 días desde que se suspendió.
  const suspension =
    change.status === "suspended" && before.status !== "suspended"
      ? { suspendedAt: now, retentionNotices: 0 }
      : change.status && change.status !== "suspended"
        ? { suspendedAt: null, retentionNotices: 0 }
        : {};
  const [after] = await tx
    .update(schema.tenant)
    .set({ ...change, ...suspension, updatedAt: now })
    .where(eq(schema.tenant.id, before.id))
    .returning();
  await audit(
    tx,
    before.id,
    actor,
    action,
    "tenant",
    before.id,
    pickBilling(before),
    after ? pickBilling(after) : null,
    now,
  );
}

function pickBilling(t: typeof schema.tenant.$inferSelect) {
  return {
    status: t.status,
    plan: t.plan,
    paidUntil: t.paidUntil,
    trialEndsAt: t.trialEndsAt,
    trialBudgetUsd: t.trialBudgetUsd,
  };
}

async function audit(
  tx: Tx,
  tenantId: string,
  actor: Reporter | null,
  action: string,
  entity: string,
  entityId: string,
  before: unknown,
  after: unknown,
  now: Date,
  channel: "admin" | "dashboard" | "whatsapp" = "admin",
): Promise<void> {
  await tx.insert(schema.auditLog).values({
    tenantId,
    actorType: !actor ? "system" : "phoneId" in actor ? "phone" : "user",
    actorId: !actor ? null : "phoneId" in actor ? actor.phoneId : actor.userId,
    action,
    entity,
    entityId,
    before: before === null ? null : JSON.parse(JSON.stringify(before)),
    after: after === null ? null : JSON.parse(JSON.stringify(after)),
    channel: actor ? channel : "system",
    createdAt: now,
  });
}
