import "server-only";
import { createBoss, type PgBoss } from "@caja/db/queue";
import { env } from "./env.js";

/** Productor de jobs: no supervisa ni migra. Se inicia una vez por proceso. */
const g = globalThis as unknown as { __cajaBoss?: Promise<PgBoss> };

export function boss(): Promise<PgBoss> {
  if (!g.__cajaBoss) {
    const b = createBoss(env().DATABASE_URL, "producer");
    g.__cajaBoss = b.start();
  }
  return g.__cajaBoss;
}
