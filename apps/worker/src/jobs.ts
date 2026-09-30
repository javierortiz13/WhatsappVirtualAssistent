import {
  bcvSource,
  dolarApiSource,
  expirePendingActions,
  type Logger,
  markWebhookEvent,
  type ProcessDeps,
  processInbound,
  refreshRates,
} from "@caja/core";
import type { Db } from "@caja/db";
import {
  cancelFailedFifoJobs,
  type PgBoss,
  PROCESS_MESSAGE_RETRY_LIMIT,
  type ProcessMessageJob,
  QUEUES,
} from "@caja/db/queue";

/**
 * Registro de handlers y cron del worker. Separado de `index.ts` para poder probarlo.
 * Cron en hora de Caracas: el BCV publica entre 15:00 y 18:00 en días hábiles; se consulta cada
 * 30 minutos entre 15:00 y 20:00, y una vez a las 08:00 por si algo falló.
 */
export const CRON = {
  ratesAfternoon: "*/30 15-20 * * 1-5",
  ratesMorning: "0 8 * * *",
  housekeeping: "*/5 * * * *",
} as const;

export async function registerJobs(opts: {
  boss: PgBoss;
  db: Db;
  deps: ProcessDeps;
  log: Logger;
  concurrency: number;
  /** Se llama con cada error de un handler antes de relanzarlo (Sentry en producción). */
  onError?: (err: unknown, queue: string) => void;
}) {
  const { boss, db, deps, log } = opts;
  const guarded =
    <T>(queue: string, fn: (jobs: T[]) => Promise<void>) =>
    async (jobs: T[]) => {
      try {
        await fn(jobs);
      } catch (err) {
        log.error({ queue, err: err instanceof Error ? err.message : String(err) }, "job falló");
        opts.onError?.(err, queue);
        throw err;
      }
    };

  await boss.work<ProcessMessageJob>(
    QUEUES.processMessage,
    { batchSize: 1, pollingIntervalSeconds: 1, localConcurrency: opts.concurrency },
    guarded(QUEUES.processMessage, async (jobs) => {
      for (const job of jobs) {
        const started = Date.now();
        try {
          const outcome = await processInbound(deps, job.data);
          log.info(
            { jobId: job.id, outcome, ms: Date.now() - started, retry: job.retryCount },
            "job procesado",
          );
        } catch (err) {
          if (job.retryCount < PROCESS_MESSAGE_RETRY_LIMIT) throw err;
          // Último intento: en `failed` bloquearía para siempre la cola FIFO de este teléfono.
          // Se cierra el job, se marca el evento y se avisa; el mensaje no se responde.
          const message = err instanceof Error ? err.message : String(err);
          log.error(
            { jobId: job.id, retry: job.retryCount, err: message },
            "job agotó los reintentos; se cierra para no bloquear el teléfono",
          );
          opts.onError?.(err, QUEUES.processMessage);
          await markWebhookEvent(db, job.data.webhookEventId, "failed", message.slice(0, 500));
        }
      }
    }),
  );

  await boss.work(
    QUEUES.fetchBcvRate,
    { batchSize: 1, pollingIntervalSeconds: 5 },
    guarded(QUEUES.fetchBcvRate, async () => {
      const result = await refreshRates({ db, sources: [bcvSource(), dolarApiSource()], log });
      if (!result.source) throw new Error(`tasa BCV: ${result.errors.join(" | ")}`);
    }),
  );

  await boss.work(
    QUEUES.housekeeping,
    { batchSize: 1, pollingIntervalSeconds: 5 },
    guarded(QUEUES.housekeeping, async () => {
      const expired = await expirePendingActions(db, new Date());
      if (expired > 0) log.info({ expired }, "borradores vencidos");
      // Jobs vencidos por tiempo que quedaron en `failed`: desbloquear el teléfono.
      const stuck = await cancelFailedFifoJobs(db);
      for (const s of stuck) {
        if (s.webhookEventId)
          await markWebhookEvent(
            db,
            s.webhookEventId,
            "failed",
            "job vencido o fallido; cancelado",
          );
      }
      if (stuck.length > 0) log.warn({ jobs: stuck.map((s) => s.jobId) }, "jobs FIFO cancelados");
    }),
  );

  await boss.schedule(QUEUES.fetchBcvRate, CRON.ratesAfternoon, null, {
    tz: "America/Caracas",
    key: "afternoon",
  });
  await boss.schedule(QUEUES.fetchBcvRate, CRON.ratesMorning, null, {
    tz: "America/Caracas",
    key: "morning",
  });
  await boss.schedule(QUEUES.housekeeping, CRON.housekeeping, null, {
    tz: "America/Caracas",
    key: "every-5-min",
  });
}
