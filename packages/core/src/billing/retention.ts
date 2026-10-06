import { and, type Db, desc, eq, everyTenantId, schema, withTenant } from "@caja/db";
import type { Logger } from "../log";
import { type AuthAdmin, cleanupErased, eraseTenant, requestDeletion } from "../onboarding/erase";
import type { ObjectStore } from "../storage/index";

/**
 * Cuánto se guardan los datos (0017, decidido por Javier el 06/10):
 * - Suspendido por impago: 90 días desde `suspended_at`. Avisos a los 60 y a los 83 días; al día 90
 *   pasa a la papelera (motivo `unpaid`).
 * - Papelera: 15 días; al vencer `purge_after` se borra todo de verdad.
 * Corre en el housekeeping del worker.
 */
export const UNPAID_RETENTION_DAYS = 90;
export const RETENTION_NOTICE_DAYS = [60, 83] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export type RetentionNotice = {
  tenantId: string;
  tenantName: string;
  level: 1 | 2;
  /** Día en que los datos pasan a la papelera si no renueva. */
  trashOn: Date;
  owner: { e164: string; phoneId: string } | null;
  /** Último mensaje del dueño al bot: dentro de 24 h se puede escribir sin plantilla. */
  lastInboundAt: Date | null;
};

/** Fecha en que los datos de un negocio suspendido pasan a la papelera. */
export function unpaidTrashDate(suspendedAt: Date): Date {
  return new Date(suspendedAt.getTime() + UNPAID_RETENTION_DAYS * DAY_MS);
}

export async function retentionSweep(
  db: Db,
  now: Date,
  deps: { store?: ObjectStore | null; auth?: AuthAdmin | null; log?: Logger } = {},
): Promise<{
  purged: string[];
  trashed: string[];
  notices: RetentionNotice[];
  errors: { tenantId: string; err: string }[];
}> {
  const purged: string[] = [];
  const trashed: string[] = [];
  const notices: RetentionNotice[] = [];
  const errors: { tenantId: string; err: string }[] = [];
  for (const tenantId of await everyTenantId(db)) {
    try {
      const erased = await withTenant(db, tenantId, async (tx) => {
        const [t] = await tx
          .select()
          .from(schema.tenant)
          .where(eq(schema.tenant.id, tenantId))
          .for("update");
        if (!t) return null;
        // 1) Papelera vencida: borrado definitivo.
        if (t.deletedAt) {
          if (t.purgeAfter && t.purgeAfter.getTime() <= now.getTime())
            return eraseTenant(tx, tenantId);
          return null;
        }
        if (t.status !== "suspended" || !t.suspendedAt) return null;
        const days = (now.getTime() - t.suspendedAt.getTime()) / DAY_MS;
        // 2) 90 días suspendido: a la papelera.
        if (days >= UNPAID_RETENTION_DAYS) {
          await requestDeletion(tx, {
            tenantId,
            reason: "unpaid",
            actor: { type: "system" },
            channel: "system",
            now,
          });
          trashed.push(tenantId);
          return null;
        }
        // 3) Avisos a los 60 y 83 días (uno por nivel).
        const level = RETENTION_NOTICE_DAYS.filter((d) => days >= d).length as 0 | 1 | 2;
        if (level > t.retentionNotices) {
          await tx
            .update(schema.tenant)
            .set({ retentionNotices: level })
            .where(eq(schema.tenant.id, tenantId));
          const [owner] = await tx
            .select({ id: schema.phoneNumber.id, e164: schema.phoneNumber.e164 })
            .from(schema.phoneNumber)
            .where(
              and(
                eq(schema.phoneNumber.tenantId, tenantId),
                eq(schema.phoneNumber.role, "owner"),
                eq(schema.phoneNumber.status, "active"),
              ),
            )
            .limit(1);
          const [last] = owner
            ? await tx
                .select({ at: schema.message.createdAt })
                .from(schema.message)
                .where(
                  and(eq(schema.message.phoneId, owner.id), eq(schema.message.direction, "in")),
                )
                .orderBy(desc(schema.message.createdAt))
                .limit(1)
            : [];
          notices.push({
            tenantId,
            tenantName: t.name,
            level: level as 1 | 2,
            trashOn: unpaidTrashDate(t.suspendedAt),
            owner: owner ? { e164: owner.e164, phoneId: owner.id } : null,
            lastInboundAt: last?.at ?? null,
          });
        }
        return null;
      });
      if (erased) {
        purged.push(tenantId);
        const cleaned = await cleanupErased(erased, deps);
        deps.log?.info({ tenantId, ...cleaned }, "negocio borrado al vencer la papelera");
      }
    } catch (err) {
      errors.push({ tenantId, err: err instanceof Error ? err.message : String(err) });
    }
  }
  return { purged, trashed, notices, errors };
}
