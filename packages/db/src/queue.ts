import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";
import type { Tx } from "./client";
import { pgConnection } from "./ssl";

/**
 * Cola de trabajos sobre Postgres (ADR-003). Un solo lugar define nombres de cola, políticas y
 * tipos de datos de cada job, compartidos por web (encola) y worker (procesa).
 */
export const QUEUES = {
  /** Un mensaje entrante de WhatsApp. Serializado por teléfono con `key_strict_fifo`. */
  processMessage: "process-message",
  /** Cron de tasa BCV (día 4). */
  fetchBcvRate: "fetch-bcv-rate",
  /** Expiración de borradores y limpieza (día 3 en adelante). */
  housekeeping: "housekeeping",
} as const;

export const PGBOSS_SCHEMA = "pgboss";

export type ProcessMessageJob = {
  webhookEventId: string;
  waMessageId: string;
  phoneNumberId: string;
  senderE164: string | null;
  senderWaUserId: string | null;
};

export type BossRole = "producer" | "worker";

/**
 * `producer` (web): no supervisa, no programa, no migra; solo encola.
 * `worker`: supervisa, mantiene y ejecuta. La instalación del schema `pgboss` la hace el worker
 * con `migrate: true` la primera vez (requiere que el rol tenga CREATE en la base) o una
 * migración manual con `getConstructionPlans`.
 */
export function createBoss(connectionString: string, role: BossRole): PgBoss {
  return new PgBoss({
    ...pgConnection(connectionString),
    schema: PGBOSS_SCHEMA,
    application_name: `caja-${role}`,
    max: role === "producer" ? 2 : 5,
    supervise: role === "worker",
    schedule: role === "worker",
    migrate: role === "worker",
    createSchema: role === "worker",
  });
}

/** Crea o actualiza las colas con su política. Idempotente. Lo llama el worker al arrancar. */
export async function ensureQueues(boss: PgBoss): Promise<void> {
  const defs: {
    name: string;
    policy: "key_strict_fifo" | "standard" | "singleton";
    retryLimit: number;
    retryDelay: number;
    expireInSeconds: number;
  }[] = [
    {
      name: QUEUES.processMessage,
      policy: "key_strict_fifo",
      retryLimit: 1,
      retryDelay: 15,
      expireInSeconds: 120,
    },
    {
      name: QUEUES.fetchBcvRate,
      policy: "singleton",
      retryLimit: 3,
      retryDelay: 60,
      expireInSeconds: 60,
    },
    {
      name: QUEUES.housekeeping,
      policy: "singleton",
      retryLimit: 1,
      retryDelay: 60,
      expireInSeconds: 300,
    },
  ];
  for (const { name, ...options } of defs) {
    const existing = await boss.getQueue(name);
    if (existing)
      await boss.updateQueue(name, {
        retryLimit: options.retryLimit,
        retryDelay: options.retryDelay,
        expireInSeconds: options.expireInSeconds,
      });
    else await boss.createQueue(name, { ...options, retryBackoff: true });
  }
}

/** Encola dentro de la transacción de Drizzle que registró el evento: o entran ambos o ninguno. */
export async function enqueueProcessMessage(
  boss: PgBoss,
  tx: Tx,
  job: ProcessMessageJob,
  serializationKey: string,
): Promise<string | null> {
  return boss.send(QUEUES.processMessage, job, {
    singletonKey: serializationKey,
    db: fromDrizzle(tx, sql),
  });
}

export type { PgBoss };
