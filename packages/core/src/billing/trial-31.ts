import { and, type Db, desc, eq, everyTenantId, inArray, schema, withTenant } from "@caja/db";
import { setTenantBilling } from "./payments";
import { TRIAL_DAYS } from "./plans";
import { subscriptionState } from "./subscription";
import { trialSpend } from "./trial";

/**
 * Ajuste a la prueba de 31 días (28/10/2026, decisión de Javier 1A y 2A; handoff trial-31 T8).
 * Para cada negocio, la primera regla que aplica, con meta = created_at + TRIAL_DAYS días. Solo
 * `extender_en_curso`, `extender_en_gracia` y `reabrir_suspendido` cambian, y solo con `apply`:
 * `trial_ends_at = meta` por `setTenantBilling` (audit `extend` del sistema). No manda mensajes.
 * Idempotente: una segunda corrida deja todo en "sin cambio".
 */
export const TRIAL31_RULES = [
  "sin_cambio_borrado",
  "sin_cambio_pagado",
  "sin_cambio_mas_de_31_dias",
  "sin_cambio_ya_tiene_31",
  "sin_cambio_tope_de_mensajes",
  "reabrir_suspendido",
  "sin_cambio_suspendido_a_mano",
  "extender_en_curso",
  "extender_en_gracia",
  "sin_cambio_otro",
] as const;
export type Trial31Rule = (typeof TRIAL31_RULES)[number];

const CHANGES: readonly Trial31Rule[] = [
  "extender_en_curso",
  "extender_en_gracia",
  "reabrir_suspendido",
];

type TenantRow = typeof schema.tenant.$inferSelect;

/** La regla de un negocio (a–i del handoff), dentro de su transacción. */
export async function trial31Rule(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  t: TenantRow,
  now: Date,
): Promise<Trial31Rule> {
  const meta = new Date(t.createdAt.getTime() + TRIAL_DAYS * 86_400_000);
  if (t.deletedAt) return "sin_cambio_borrado";
  if (t.paidUntil || t.status === "active") return "sin_cambio_pagado";
  if (meta.getTime() <= now.getTime()) return "sin_cambio_mas_de_31_dias";
  // Nunca se acorta: p. ej. una prueba extendida a mano desde /admin.
  if (t.trialEndsAt && t.trialEndsAt.getTime() >= meta.getTime()) return "sin_cambio_ya_tiene_31";
  // Terminó por "lo que llegue primero": los mensajes o la red de seguridad en dólares (A3). Se
  // mide como prueba aunque ya esté suspendida: si no, una prueba agotada que después venció se
  // reabriría.
  if ((await trialSpend(tx, { ...t, status: "trial" })).reached)
    return "sin_cambio_tope_de_mensajes";
  if (t.status === "suspended") {
    const [last] = await tx
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.tenantId, t.id),
          eq(schema.auditLog.entity, "tenant"),
          inArray(schema.auditLog.action, ["suspend", "suspend_expired"]),
        ),
      )
      .orderBy(desc(schema.auditLog.createdAt), desc(schema.auditLog.id))
      .limit(1);
    return last?.action === "suspend_expired"
      ? "reabrir_suspendido"
      : "sin_cambio_suspendido_a_mano";
  }
  if (t.status === "trial")
    return subscriptionState(t, now).kind === "trial" ? "extender_en_curso" : "extender_en_gracia";
  return "sin_cambio_otro";
}

export type Trial31Counts = Record<Trial31Rule, { total: number; internal: number }>;

/**
 * Recorre todos los negocios (con la URL de administrador). Devuelve solo conteos por regla:
 * nunca nombres, teléfonos, correos ni ids.
 */
export async function runTrial31(
  db: Db,
  opts: { now: Date; apply: boolean },
): Promise<Trial31Counts> {
  const counts = Object.fromEntries(
    TRIAL31_RULES.map((r) => [r, { total: 0, internal: 0 }]),
  ) as Trial31Counts;
  for (const tenantId of await everyTenantId(db)) {
    await withTenant(db, tenantId, async (tx) => {
      // Bloqueada, como en el job de cobros (enforce.ts): no se cruza con un pago o una suspensión.
      const [t] = await tx
        .select()
        .from(schema.tenant)
        .where(eq(schema.tenant.id, tenantId))
        .for("update");
      if (!t) return;
      const rule = await trial31Rule(tx, t, opts.now);
      counts[rule].total += 1;
      if ((t.crmTags ?? []).some((g) => g.trim().toLowerCase() === "interna"))
        counts[rule].internal += 1;
      if (opts.apply && CHANGES.includes(rule))
        await setTenantBilling(
          tx,
          t,
          {
            status: "trial",
            trialEndsAt: new Date(t.createdAt.getTime() + TRIAL_DAYS * 86_400_000),
          },
          null,
          opts.now,
          "extend",
        );
    });
  }
  return counts;
}
