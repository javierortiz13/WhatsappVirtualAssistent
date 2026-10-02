import "server-only";
import { createDb, type Db } from "@caja/db";
import { env } from "./env";

/** Conexión única por proceso. En desarrollo, Next recarga módulos: se guarda en `globalThis`. */
const g = globalThis as unknown as { __cajaDb?: ReturnType<typeof createDb> };

export function db(): Db {
  // Serverless: pocas conexiones por instancia y que se suelten rápido (pooler de 15 por rol).
  if (!g.__cajaDb) g.__cajaDb = createDb(env().DATABASE_URL, { max: 2, idleTimeoutSec: 20 });
  return g.__cajaDb.db;
}
