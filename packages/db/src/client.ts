import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Db = ReturnType<typeof createDb>["db"];
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Crea la conexión de la aplicación. `max` bajo a propósito: web y worker son procesos
 * pequeños y Supabase limita conexiones directas.
 */
export function createDb(url: string, opts: { max?: number } = {}) {
  const client = postgres(url, {
    max: opts.max ?? 5,
    prepare: false,
    onnotice: () => {},
  });
  const db = drizzle(client, { schema, casing: "snake_case" });
  return { db, client, close: () => client.end({ timeout: 5 }) };
}

/**
 * Único punto de entrada para trabajar con datos de un tenant. Abre una transacción y fija
 * `app.tenant_id` con `set_config(..., true)` (alcance de transacción). Las políticas RLS usan
 * ese valor; fuera de esta función, las consultas a tablas de tenant devuelven cero filas.
 */
export async function withTenant<T>(
  db: Db,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
