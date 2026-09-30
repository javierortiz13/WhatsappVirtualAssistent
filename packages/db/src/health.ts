import { sql } from "drizzle-orm";
import { type Queryable, rows } from "./client";
import { QUEUES } from "./queue";

/**
 * Salud del sistema para el monitor externo (S2): base accesible, worker vivo y cola sin atasco.
 * No se necesita una tabla de latidos: el worker corre `housekeeping` cada 5 minutos y pg-boss
 * guarda cuándo terminó; y un job de `process-message` esperando más de lo normal significa que
 * nadie lo toma o que un teléfono quedó bloqueado.
 */
export type Health = {
  ok: boolean;
  db: boolean;
  worker: { ok: boolean; lastHousekeepingAt: string | null; ageSeconds: number | null };
  queue: { ok: boolean; waiting: number; oldestWaitingSeconds: number | null };
};

export const HEALTH_LIMITS = {
  /** El housekeeping corre cada 5 min; 15 sin terminar uno = worker caído o sin base. */
  workerStaleSeconds: 15 * 60,
  /** Un mensaje normal se toma en segundos; 3 minutos esperando = nadie lo procesa. */
  queueStaleSeconds: 3 * 60,
} as const;

export async function checkHealth(db: Queryable, now: Date = new Date()): Promise<Health> {
  const nowIso = now.toISOString();
  try {
    const [w] = rows<{ last: string | null }>(
      await db.execute(sql`
        select max(completed_on)::text as last
        from pgboss.job
        where name = ${QUEUES.housekeeping} and state = 'completed'
      `),
    );
    const [q] = rows<{ waiting: number; oldest: string | null }>(
      await db.execute(sql`
        select count(*)::int as waiting, min(created_on)::text as oldest
        from pgboss.job
        where name = ${QUEUES.processMessage}
          and state in ('created', 'retry')
          and start_after <= ${nowIso}::timestamptz
      `),
    );
    const lastAt = w?.last ? new Date(w.last) : null;
    const workerAge = lastAt ? Math.round((now.getTime() - lastAt.getTime()) / 1000) : null;
    const oldest = q?.oldest ? new Date(q.oldest) : null;
    const queueAge = oldest ? Math.round((now.getTime() - oldest.getTime()) / 1000) : null;
    const worker = {
      ok: workerAge !== null && workerAge <= HEALTH_LIMITS.workerStaleSeconds,
      lastHousekeepingAt: lastAt?.toISOString() ?? null,
      ageSeconds: workerAge,
    };
    const queue = {
      ok: queueAge === null || queueAge <= HEALTH_LIMITS.queueStaleSeconds,
      waiting: Number(q?.waiting ?? 0),
      oldestWaitingSeconds: queueAge,
    };
    return { ok: worker.ok && queue.ok, db: true, worker, queue };
  } catch {
    return {
      ok: false,
      db: false,
      worker: { ok: false, lastHousekeepingAt: null, ageSeconds: null },
      queue: { ok: false, waiting: 0, oldestWaitingSeconds: null },
    };
  }
}
