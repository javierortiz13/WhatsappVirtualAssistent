import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index";
import { sslFromEnv } from "./ssl";

export type Db = ReturnType<typeof createDb>["db"];
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Conexión o transacción: lo que aceptan las consultas de lectura y escritura del dominio. */
export type Queryable = Db | Tx;

/**
 * `execute()` devuelve un arreglo con postgres.js y `{ rows }` con PGlite (tests). Este helper
 * normaliza para que el dominio no dependa del driver.
 */
export function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const r = result as { rows?: T[] } | null;
  return r?.rows ?? [];
}

/**
 * drizzle deja pasar tal cual los parámetros de fecha (sus columnas ya los mandan como texto ISO).
 * Una fecha de JavaScript dentro de SQL escrito a mano (`sql\`... ${new Date()}\``) llegaba como
 * objeto y postgres.js fallaba al armar la consulta (08/11: `recordsTouchedSince` con Puntos
 * encendido, y en silencio `reminderStats` en /admin). PGlite sí la convierte, por eso las pruebas
 * no lo veían. Aquí se convierte una vez para toda la aplicación; el texto sigue igual.
 */
export function serializeDates(client: ReturnType<typeof postgres>): void {
  const dateParam = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
  const serializers = client.options.serializers as Record<string, (v: unknown) => unknown>;
  // timestamptz y timestamp: los tipos que postgres.js le asigna a un Date.
  for (const type of ["1184", "1114"]) serializers[type] = dateParam;
}

/**
 * Crea la conexión de la aplicación. `max` bajo a propósito: web y worker son procesos
 * pequeños y Supabase limita conexiones directas.
 */
export function createDb(url: string, opts: { max?: number; idleTimeoutSec?: number } = {}) {
  const ssl = sslFromEnv();
  const client = postgres(url, {
    max: opts.max ?? 5,
    // Sin esto postgres.js nunca suelta una conexión inactiva. En Vercel cada instancia caliente
    // o congelada retenía sus lugares en el pooler de sesión (15 por rol) y, con dos workers
    // conviviendo durante un deploy, la siguiente instancia no conseguía conexión (02/10).
    ...(opts.idleTimeoutSec ? { idle_timeout: opts.idleTimeoutSec } : {}),
    prepare: false,
    onnotice: () => {},
    ...(ssl ? { ssl } : {}),
  });
  const db = drizzle(client, { schema, casing: "snake_case" });
  serializeDates(client);
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
