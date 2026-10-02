"use server";

import {
  approvePayment,
  Decimal,
  latestRates,
  PLANS,
  parseVenezuelanAmount,
  planById,
  quote,
  recordPayment,
  rejectPayment,
  setTenantBilling,
  subscriptionState,
} from "@caja/core";
import { eq, schema, withTenant } from "@caja/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { db } from "@/lib/db";

const DAY = 24 * 60 * 60 * 1000;
const PlanId = z.enum(PLANS.map((p) => p.id) as ["personal", "negocio", "negocio_plus"]);
const back = (tenantId: string, q: string) => redirect(`/admin/negocios/${tenantId}?${q}`);

function fail(tenantId: string, code: string, err?: unknown): never {
  if (err)
    console.error(JSON.stringify({ level: "error", msg: `admin ${code}`, detail: String(err) }));
  return back(tenantId, `error=${code}`);
}

const PaymentForm = z.object({
  tenant_id: z.string().uuid(),
  plan: PlanId,
  method: z.enum(["pago_movil", "zelle", "binance"]),
  months: z.coerce.number().int().min(1).max(12),
  amount: z.string().trim().min(1),
  reference: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(300).optional(),
  approve: z.literal("on").optional(),
});

/** Registra un pago que el cliente reportó; marcado "aprobar", activa el plan de una vez. */
export async function recordPaymentAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = PaymentForm.safeParse(Object.fromEntries(formData));
  const tenantId = String(formData.get("tenant_id") ?? "");
  if (!parsed.success) fail(tenantId, "datos");
  const f = parsed.data;
  // "19.99", "19,99", "19.527,03" y "19527.03" se leen bien; "1.200" son mil doscientos.
  const amount = parseVenezuelanAmount(f.amount);
  if (!amount || amount.lte(0)) fail(tenantId, "monto");
  const plan = planById(f.plan);
  const q = quote(plan, f.method, f.months, await latestRates(db()));
  const now = new Date();
  try {
    await withTenant(db(), f.tenant_id, (tx) =>
      recordPayment(
        tx,
        {
          tenantId: f.tenant_id,
          plan: plan.id,
          months: f.months,
          method: f.method,
          amount,
          currency: f.method === "pago_movil" ? "VES" : f.method === "zelle" ? "USD" : "USDT",
          rateKind: q?.rateKind ?? null,
          rateValue: q?.rateValue ?? null,
          amountUsd: new Decimal(plan.priceUsd).mul(f.months),
          reference: f.reference || null,
          notes: f.notes || null,
        },
        admin,
        now,
        { approve: f.approve === "on" },
      ),
    );
  } catch (err) {
    fail(f.tenant_id, "servidor", err);
  }
  revalidatePath("/admin");
  back(f.tenant_id, f.approve === "on" ? "ok=pago_aprobado" : "ok=pago_registrado");
}

const PaymentRef = z.object({
  tenant_id: z.string().uuid(),
  payment_id: z.string().uuid(),
  reason: z.string().trim().max(300).optional(),
  from: z.enum(["panel", "negocio"]).optional(),
});

export async function approvePaymentAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = PaymentRef.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/admin?error=datos");
  const f = parsed.data;
  try {
    await withTenant(db(), f.tenant_id, (tx) =>
      approvePayment(tx, f.tenant_id, f.payment_id, admin, new Date()),
    );
  } catch (err) {
    fail(f.tenant_id, "servidor", err);
  }
  revalidatePath("/admin");
  if (f.from === "panel") redirect("/admin?ok=pago_aprobado");
  back(f.tenant_id, "ok=pago_aprobado");
}

export async function rejectPaymentAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = PaymentRef.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/admin?error=datos");
  const f = parsed.data;
  try {
    await withTenant(db(), f.tenant_id, (tx) =>
      rejectPayment(tx, f.tenant_id, f.payment_id, admin, f.reason || null, new Date()),
    );
  } catch (err) {
    fail(f.tenant_id, "servidor", err);
  }
  revalidatePath("/admin");
  if (f.from === "panel") redirect("/admin?ok=pago_rechazado");
  back(f.tenant_id, "ok=pago_rechazado");
}

const TenantChange = z.object({
  tenant_id: z.string().uuid(),
  op: z.enum(["plan", "extend", "suspend", "reactivate"]),
  plan: PlanId.optional(),
  days: z.coerce.number().int().min(1).max(366).optional(),
});

/**
 * Cambios sin pago: cambiar plan, extender (cortesía o prueba más larga), suspender a mano o
 * reactivar. Reactivar solo si queda vigencia; si no, primero se extiende o se registra un pago.
 */
export async function changeTenantAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = TenantChange.safeParse(Object.fromEntries(formData));
  const tenantId = String(formData.get("tenant_id") ?? "");
  if (!parsed.success) fail(tenantId, "datos");
  const f = parsed.data;
  const now = new Date();
  let outcome = "ok=guardado";
  try {
    await withTenant(db(), f.tenant_id, async (tx) => {
      const [t] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, f.tenant_id));
      if (!t) throw new Error("negocio no encontrado");
      if (f.op === "plan") {
        if (!f.plan) throw new Error("falta el plan");
        await setTenantBilling(tx, t, { plan: f.plan }, admin, now, "change_plan");
      } else if (f.op === "extend") {
        const days = f.days ?? 7;
        const paid = t.paidUntil !== null || t.status === "active";
        const from = Math.max(now.getTime(), (paid ? t.paidUntil : t.trialEndsAt)?.getTime() ?? 0);
        const until = new Date(from + days * DAY);
        await setTenantBilling(
          tx,
          t,
          paid ? { status: "active", paidUntil: until } : { status: "trial", trialEndsAt: until },
          admin,
          now,
          "extend",
        );
      } else if (f.op === "suspend") {
        await setTenantBilling(tx, t, { status: "suspended" }, admin, now, "suspend");
      } else {
        const back = t.paidUntil ? "active" : "trial";
        const state = subscriptionState({ ...t, status: back }, now);
        if (state.kind === "expired") {
          outcome = "error=sin_vigencia";
          return;
        }
        await setTenantBilling(tx, t, { status: back }, admin, now, "reactivate");
      }
    });
  } catch (err) {
    fail(f.tenant_id, "servidor", err);
  }
  revalidatePath("/admin");
  back(f.tenant_id, outcome);
}
