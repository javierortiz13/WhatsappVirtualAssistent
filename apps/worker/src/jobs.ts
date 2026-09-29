import {
  bcvSource,
  dolarApiSource,
  expirePendingActions,
  type Logger,
  type ProcessDeps,
  processInbound,
  refreshRates,
} from "@caja/core";
import type { Db } from "@caja/db";
import { type PgBoss, type ProcessMessageJob, QUEUES } from "@caja/db/queue";

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
}) {
  const { boss, db, deps, log } = opts;

  await boss.work<ProcessMessageJob>(
    QUEUES.processMessage,
    { batchSize: 1, pollingIntervalSeconds: 1, localConcurrency: opts.concurrency },
    async (jobs) => {
      for (const job of jobs) {
        const started = Date.now();
        const outcome = await processInbound(deps, job.data);
        log.info(
          { jobId: job.id, outcome, ms: Date.now() - started, retry: job.retryCount },
          "job procesado",
        );
      }
    },
  );

  await boss.work(QUEUES.fetchBcvRate, { batchSize: 1, pollingIntervalSeconds: 5 }, async () => {
    const result = await refreshRates({ db, sources: [bcvSource(), dolarApiSource()], log });
    if (!result.source) throw new Error(`tasa BCV: ${result.errors.join(" | ")}`);
  });

  await boss.work(QUEUES.housekeeping, { batchSize: 1, pollingIntervalSeconds: 5 }, async () => {
    const expired = await expirePendingActions(db, new Date());
    if (expired > 0) log.info({ expired }, "borradores vencidos");
  });

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
