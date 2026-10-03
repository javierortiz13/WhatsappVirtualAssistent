import "server-only";
import { createBoss, type PgBoss } from "@caja/db/queue";
import { env } from "./env";

/** Productor de jobs: no supervisa ni migra. Se inicia una vez por proceso. */
const g = globalThis as unknown as { __cajaBoss?: Promise<PgBoss> | undefined };

export function boss(): Promise<PgBoss> {
  if (!g.__cajaBoss) {
    const b = createBoss(env().DATABASE_URL, "producer");
    // Si el arranque falla (un corte de la base), no se guarda la promesa rechazada: el próximo
    // webhook lo intenta de nuevo en vez de fallar hasta que se recicle la instancia.
    g.__cajaBoss = b.start().catch((err) => {
      g.__cajaBoss = undefined;
      throw err;
    });
  }
  return g.__cajaBoss;
}
