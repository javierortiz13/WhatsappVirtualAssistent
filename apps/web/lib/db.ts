import "server-only";
import { createDb, type Db } from "@caja/db";
import { env } from "./env.js";

/** Conexión única por proceso. En desarrollo, Next recarga módulos: se guarda en `globalThis`. */
const g = globalThis as unknown as { __cajaDb?: ReturnType<typeof createDb> };

export function db(): Db {
  if (!g.__cajaDb) g.__cajaDb = createDb(env().DATABASE_URL, { max: 3 });
  return g.__cajaDb.db;
}
