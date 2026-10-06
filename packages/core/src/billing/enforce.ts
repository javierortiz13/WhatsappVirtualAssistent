import { type Db, eq, everyTenantId, schema, withTenant } from "@caja/db";
import { setTenantBilling } from "./payments";
import { planById } from "./plans";
import { subscriptionState } from "./subscription";
import { trialSpend } from "./trial";
import { monthUsage } from "./usage";

/**
 * Vuelta de cobros (corre en el housekeeping del worker):
 * 1. Suspende los negocios cuya prueba o período pagado venció hace más de 3 días.
 * 2. Detecta los que pasaron el límite de mensajes del plan este mes y los devuelve una sola vez
 *    por mes, para avisarle al administrador (decisión del 02/10: el bot sigue funcionando).
 * 3. Detecta las pruebas que llegaron a su tope de gasto (0016; ahí el bot sí para) y las devuelve
 *    una sola vez, para que el administrador decida si les da más.
 */
export type OverCap = { tenantId: string; plan: string; used: number; cap: number };
export type TrialCapped = { tenantId: string; plan: string; spentUsd: string; budgetUsd: string };

export async function enforceBilling(
  db: Db,
  now: Date,
): Promise<{
  suspended: string[];
  overCap: OverCap[];
  trialCapped: TrialCapped[];
  errors: { tenantId: string; err: string }[];
}> {
  const suspended: string[] = [];
  const overCap: OverCap[] = [];
  const trialCapped: TrialCapped[] = [];
  const errors: { tenantId: string; err: string }[] = [];
  for (const tenantId of await everyTenantId(db)) {
    try {
      await enforceTenant(db, tenantId, now, suspended, overCap, trialCapped);
    } catch (err) {
      // Un negocio con error no frena la vuelta de los demás; el siguiente housekeeping reintenta.
      errors.push({ tenantId, err: err instanceof Error ? err.message : String(err) });
    }
  }
  return { suspended, overCap, trialCapped, errors };
}

async function enforceTenant(
  db: Db,
  tenantId: string,
  now: Date,
  suspended: string[],
  overCap: OverCap[],
  trialCapped: TrialCapped[],
): Promise<void> {
  await withTenant(db, tenantId, async (tx) => {
    // Bloqueado como al aprobar un pago: si la aprobación entra a la vez, este lee el
    // paid_until nuevo y no suspende a un negocio que acaba de pagar.
    const [t] = await tx
      .select()
      .from(schema.tenant)
      .where(eq(schema.tenant.id, tenantId))
      .for("update");
    if (!t) return;
    if (subscriptionState(t, now).kind === "expired") {
      await setTenantBilling(tx, t, { status: "suspended" }, null, now, "suspend_expired");
      suspended.push(tenantId);
      return;
    }
    if (t.status === "suspended") return;
    if (t.status === "trial" && !t.trialCapNotifiedAt) {
      const spend = await trialSpend(tx, t);
      if (spend.reached) {
        await tx
          .update(schema.tenant)
          .set({ trialCapNotifiedAt: now })
          .where(eq(schema.tenant.id, tenantId));
        trialCapped.push({
          tenantId,
          plan: t.plan,
          spentUsd: spend.spentUsd.toFixed(2),
          budgetUsd: spend.budgetUsd.toFixed(2),
        });
      }
    }
    const usage = await monthUsage(tx, tenantId, now);
    const cap = planById(t.plan).messagesPerMonth;
    if (usage.inbound > cap && t.capNotifiedMonth !== usage.month) {
      await tx
        .update(schema.tenant)
        .set({ capNotifiedMonth: usage.month })
        .where(eq(schema.tenant.id, tenantId));
      overCap.push({ tenantId, plan: t.plan, used: usage.inbound, cap });
    }
  });
}
