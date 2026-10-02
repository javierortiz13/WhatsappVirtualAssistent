"use server";

import {
  Decimal,
  latestRates,
  PLANS,
  parseVenezuelanAmount,
  planById,
  quote,
  reportPayment,
  TooManyPendingError,
} from "@caja/core";
import { and, eq, schema, withTenant } from "@caja/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";

const ProfileForm = z.object({ name: z.string().trim().min(1).max(60) });

/**
 * Perfil: el nombre de la cuenta y, con él, cómo llama el asistente al dueño por WhatsApp.
 * `user_account` no tiene RLS: se actualiza solo la fila del usuario de la sesión.
 */
export async function updateProfileAction(formData: FormData): Promise<void> {
  const { user, tenant } = await requireTenant();
  const parsed = ProfileForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/ajustes/perfil?error=nombre");
  const name = parsed.data.name;
  try {
    await db().update(schema.userAccount).set({ name }).where(eq(schema.userAccount.id, user.id));
    await withTenant(db(), tenant.id, (tx) =>
      tx
        .update(schema.phoneNumber)
        .set({ displayName: name })
        .where(
          and(eq(schema.phoneNumber.tenantId, tenant.id), eq(schema.phoneNumber.role, "owner")),
        ),
    );
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "perfil", detail: String(err) }));
    redirect("/ajustes/perfil?error=servidor");
  }
  revalidatePath("/ajustes");
  redirect("/ajustes/perfil?ok=1");
}

const PlanId = z.enum(PLANS.map((p) => p.id) as ["personal", "negocio", "negocio_plus"]);
const ReportForm = z.object({
  plan: PlanId,
  method: z.enum(["pago_movil", "zelle", "binance"]),
  months: z.coerce.number().int().min(1).max(12),
  amount: z.string().trim().min(1).max(20),
  reference: z.string().trim().min(3).max(80),
});

/** "Ya pagué": deja el pago por verificar en la consola. No activa nada por sí solo. */
export async function reportPaymentAction(formData: FormData): Promise<void> {
  const { user, tenant } = await requireTenant();
  if (tenant.role !== "owner") redirect("/ajustes/plan?error=permiso");
  const parsed = ReportForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/ajustes/plan?error=datos#reportar");
  const f = parsed.data;
  const amount = parseVenezuelanAmount(f.amount);
  if (!amount || amount.lte(0)) redirect("/ajustes/plan?error=monto#reportar");
  const plan = planById(f.plan);
  const q = quote(plan, f.method, f.months, await latestRates(db()));
  try {
    await withTenant(db(), tenant.id, (tx) =>
      reportPayment(
        tx,
        {
          tenantId: tenant.id,
          plan: plan.id,
          months: f.months,
          method: f.method,
          amount,
          currency: f.method === "pago_movil" ? "VES" : f.method === "zelle" ? "USD" : "USDT",
          rateKind: q?.rateKind ?? null,
          rateValue: q?.rateValue ?? null,
          amountUsd: new Decimal(plan.priceUsd).mul(f.months),
          reference: f.reference,
          notes: null,
        },
        { userId: user.id, email: user.email },
        new Date(),
      ),
    );
  } catch (err) {
    if (err instanceof TooManyPendingError) redirect("/ajustes/plan?error=pendientes#reportar");
    console.error(JSON.stringify({ level: "error", msg: "reportar pago", detail: String(err) }));
    redirect("/ajustes/plan?error=servidor#reportar");
  }
  revalidatePath("/ajustes/plan");
  redirect("/ajustes/plan?ok=reportado#pagos");
}
