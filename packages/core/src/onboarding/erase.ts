import { eq, rows, schema, sql, type Tx } from "@caja/db";
import type { Logger } from "../log";
import type { ObjectStore } from "../storage/index";

/**
 * Eliminar un negocio (0017). Dos pasos, decididos por Javier el 06/10:
 * 1. Papelera: `requestDeletion` marca el negocio por 15 días. El bot y el panel dejan de usarlo
 *    (lo ven como estado `deleted`) y el dueño puede recuperarlo (`restoreTenant`).
 * 2. Borrado definitivo: al vencer, el housekeeping llama a `eraseTenant` (o el administrador lo
 *    borra ya). `app.erase_tenant` borra todo en la transacción y devuelve lo que vive fuera de la
 *    base (fotos y usuarios de Supabase Auth), que `cleanupErased` limpia después del commit.
 */
export const TRASH_DAYS = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

export type DeletionReason = "owner" | "admin" | "unpaid";
export type DeletionActor =
  | { type: "phone"; id: string }
  | { type: "user"; id: string }
  | { type: "system" };

async function auditTenant(
  tx: Tx,
  tenantId: string,
  actor: DeletionActor,
  channel: "whatsapp" | "dashboard" | "admin" | "system",
  action: string,
  before: unknown,
  after: unknown,
) {
  await tx.insert(schema.auditLog).values({
    tenantId,
    actorType: actor.type,
    actorId: actor.type === "system" ? null : actor.id,
    action,
    entity: "tenant",
    entityId: tenantId,
    before,
    after,
    channel,
  });
}

/** Pone el negocio en la papelera. Devuelve la fecha del borrado definitivo. */
export async function requestDeletion(
  tx: Tx,
  input: {
    tenantId: string;
    reason: DeletionReason;
    actor: DeletionActor;
    channel: "whatsapp" | "dashboard" | "admin" | "system";
    now: Date;
  },
): Promise<Date> {
  const purgeAfter = new Date(input.now.getTime() + TRASH_DAYS * DAY_MS);
  const t = schema.tenant;
  await tx
    .update(t)
    .set({
      deletedAt: input.now,
      purgeAfter,
      deletionReason: input.reason,
      updatedAt: input.now,
    })
    .where(eq(t.id, input.tenantId));
  await auditTenant(tx, input.tenantId, input.actor, input.channel, "request_deletion", null, {
    reason: input.reason,
    purgeAfter,
  });
  return purgeAfter;
}

/**
 * Saca el negocio de la papelera y queda como estaba. Si había entrado por impago, sigue
 * suspendido y sus 90 días vuelven a contar desde hoy. false si no estaba en la papelera.
 */
export async function restoreTenant(
  tx: Tx,
  input: {
    tenantId: string;
    actor: DeletionActor;
    channel: "whatsapp" | "dashboard" | "admin";
    now: Date;
  },
): Promise<boolean> {
  const t = schema.tenant;
  const [row] = await tx.select().from(t).where(eq(t.id, input.tenantId)).for("update");
  if (!row?.deletedAt) return false;
  await tx
    .update(t)
    .set({
      deletedAt: null,
      purgeAfter: null,
      deletionReason: null,
      ...(row.deletionReason === "unpaid" ? { suspendedAt: input.now, retentionNotices: 0 } : {}),
      updatedAt: input.now,
    })
    .where(eq(t.id, input.tenantId));
  await auditTenant(
    tx,
    input.tenantId,
    input.actor,
    input.channel,
    "restore",
    { reason: row.deletionReason, purgeAfter: row.purgeAfter },
    null,
  );
  return true;
}

export type ErasedTenant = { storageKeys: string[]; orphanUserIds: string[] };

/** Borrado definitivo (no se deshace). Debe correr dentro de `withTenant` del mismo negocio. */
export async function eraseTenant(tx: Tx, tenantId: string): Promise<ErasedTenant> {
  const [r] = rows<{ storage_keys: string[] | null; orphan_user_ids: string[] | null }>(
    await tx.execute(sql`select * from app.erase_tenant(${tenantId}::uuid)`),
  );
  return { storageKeys: r?.storage_keys ?? [], orphanUserIds: r?.orphan_user_ids ?? [] };
}

/** Borra usuarios de Supabase Auth con la clave service_role (solo en servidor). */
export interface AuthAdmin {
  deleteUser(id: string): Promise<void>;
}

export class SupabaseAuthAdmin implements AuthAdmin {
  readonly #base: string;
  readonly #key: string;
  readonly #fetch: typeof fetch;
  constructor(opts: { url: string; serviceKey: string; fetchImpl?: typeof fetch }) {
    this.#base = `${opts.url.replace(/\/$/, "")}/auth/v1`;
    this.#key = opts.serviceKey;
    this.#fetch = opts.fetchImpl ?? fetch;
  }
  async deleteUser(id: string): Promise<void> {
    const res = await this.#fetch(`${this.#base}/admin/users/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.#key}`, apikey: this.#key },
      signal: AbortSignal.timeout(15_000),
    });
    // 404: ya no existía (p. ej. un usuario que nunca entró al panel).
    if (!res.ok && res.status !== 404) throw new Error(`auth admin ${res.status}`);
  }
}

/** Limpieza fuera de la base, de a uno y sin cortar: lo que falle queda en el log. */
export async function cleanupErased(
  erased: ErasedTenant,
  deps: { store?: ObjectStore | null; auth?: AuthAdmin | null; log?: Logger },
): Promise<{ files: number; users: number; failed: number }> {
  let files = 0;
  let users = 0;
  let failed = 0;
  for (const key of erased.storageKeys) {
    if (!deps.store) break;
    try {
      await deps.store.delete(key);
      files++;
    } catch (err) {
      failed++;
      deps.log?.warn({ err: err instanceof Error ? err.message : String(err) }, "foto sin borrar");
    }
  }
  for (const id of erased.orphanUserIds) {
    if (!deps.auth) break;
    try {
      await deps.auth.deleteUser(id);
      users++;
    } catch (err) {
      failed++;
      deps.log?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "usuario sin borrar",
      );
    }
  }
  return { files, users, failed };
}
