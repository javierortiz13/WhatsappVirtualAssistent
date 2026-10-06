import { rows, sql, type Tx } from "@caja/db";
import type { Logger } from "../log";
import type { ObjectStore } from "../storage/index";

/**
 * Eliminar un negocio por completo (0017). Lo pide el dueño (WhatsApp o Ajustes) o el
 * administrador; quién puede pedirlo lo decide quien llama. Corre dentro de `withTenant` del mismo
 * negocio: `app.erase_tenant` borra todo en la transacción y devuelve lo que vive fuera de la base
 * (fotos del bucket y usuarios de Supabase Auth). Eso se limpia con `cleanupErased` después del
 * commit, para no perder fotos si la transacción se deshace.
 */
export type ErasedTenant = { storageKeys: string[]; orphanUserIds: string[] };

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
    // 404: ya no existía (p. ej. un usuario del seed que nunca entró).
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
