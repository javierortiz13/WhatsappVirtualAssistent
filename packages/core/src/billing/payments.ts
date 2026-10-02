import { and, eq, schema, type Tx } from "@caja/db";
import { type Decimal, toDbAmount, toDbRate } from "../domain/money";
import { PERIOD_DAYS, type PlanId } from "./plans";
import type { BillingMethod, BillingRateKind } from "./pricing";
import { extendPaidUntil } from "./subscription";

/**
 * Pagos verificados a mano (fase 1). El administrador registra el pago que el cliente le
 * reportó; al aprobarlo el negocio pasa a activo, toma el plan pagado y su vigencia se extiende
 * 30 días por mes pagado. Todo corre dentro de `withTenant` del negocio y queda en auditoría.
 */
export type Reviewer = { userId: string; email: string };

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
    })
    .returning({ id: schema.payment.id });
  if (!row) throw new Error("no se pudo registrar el pago");
  await audit(tx, p.tenantId, reviewer, "create", "payment", row.id, null, { ...p }, now);
  if (!opts.approve) return { paymentId: row.id, paidUntil: null };
  const { paidUntil } = await approvePayment(tx, p.tenantId, row.id, reviewer, now);
  return { paymentId: row.id, paidUntil };
}

export async function approvePayment(
  tx: Tx,
  tenantId: string,
  paymentId: string,
  reviewer: Reviewer,
  now: Date,
): Promise<{ paidUntil: Date }> {
  const [pay] = await tx
    .select()
    .from(schema.payment)
    .where(and(eq(schema.payment.id, paymentId), eq(schema.payment.tenantId, tenantId)));
  if (!pay) throw new Error("pago no encontrado");
  if (pay.status !== "pending") throw new Error(`el pago ya está ${pay.status}`);
  const [t] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId));
  if (!t) throw new Error("negocio no encontrado");
  const paidUntil = extendPaidUntil(t, pay.months, now, PERIOD_DAYS);
  await tx
    .update(schema.payment)
    .set({ status: "approved", reviewedBy: reviewer.email, reviewedAt: now })
    .where(eq(schema.payment.id, pay.id));
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
  await tx
    .update(schema.payment)
    .set({ status: "rejected", reviewedBy: reviewer.email, reviewedAt: now, notes: reason })
    .where(eq(schema.payment.id, pay.id));
  await audit(tx, tenantId, reviewer, "reject", "payment", pay.id, null, { reason }, now);
}

/** Cambios del administrador sin pago: plan, extender, cortesía, suspender o reactivar. */
export type TenantBillingChange = {
  status?: "trial" | "active" | "suspended";
  plan?: string;
  paidUntil?: Date | null;
  trialEndsAt?: Date | null;
};

export async function setTenantBilling(
  tx: Tx,
  before: typeof schema.tenant.$inferSelect,
  change: TenantBillingChange,
  actor: Reviewer | null,
  now: Date,
  action: string,
): Promise<void> {
  const [after] = await tx
    .update(schema.tenant)
    .set({ ...change, updatedAt: now })
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
  return { status: t.status, plan: t.plan, paidUntil: t.paidUntil, trialEndsAt: t.trialEndsAt };
}

async function audit(
  tx: Tx,
  tenantId: string,
  actor: Reviewer | null,
  action: string,
  entity: string,
  entityId: string,
  before: unknown,
  after: unknown,
  now: Date,
): Promise<void> {
  await tx.insert(schema.auditLog).values({
    tenantId,
    actorType: actor ? "user" : "system",
    actorId: actor?.userId ?? null,
    action,
    entity,
    entityId,
    before: before === null ? null : JSON.parse(JSON.stringify(before)),
    after: after === null ? null : JSON.parse(JSON.stringify(after)),
    channel: actor ? "admin" : "system",
    createdAt: now,
  });
}
