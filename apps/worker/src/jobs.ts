import {
  type AuthAdmin,
  bcvSource,
  dolarApiSource,
  enforceBilling,
  expirePendingActions,
  type Logger,
  markWebhookEvent,
  type ObjectStore,
  type OverCap,
  type ProcessDeps,
  processInbound,
  purgeOldTenantData,
  purgeOldWebhookPayloads,
  refreshRates,
  retentionSweep,
  sendPaymentNotices,
  sendRetentionNotices,
  sweepOrphanAttachments,
  type TrialCapped,
} from "@caja/core";
import { allTenantIds, type Db, withTenant } from "@caja/db";
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
  store?: ObjectStore | null;
  log: Logger;
  concurrency: number;
  /** Número de la plataforma desde el que salen los avisos de pago verificado. */
  platformPhoneNumberId?: string;
  /** Se llama con cada error de un handler antes de relanzarlo (Sentry en producción). */
  onError?: (err: unknown, queue: string) => void;
  /** Negocios que pasaron el límite de mensajes del plan este mes (una vez por mes cada uno). */
  onOverCap?: (items: OverCap[]) => void;
  onTrialCapped?: (items: TrialCapped[]) => void;
  /** Borra de Supabase Auth a los usuarios del panel de un negocio borrado (0017). */
  authAdmin?: AuthAdmin | null;
  /** Plantilla para los avisos de borrado por impago fuera de las 24 h. */
  retentionTemplate?: { name: string; language: string } | null;
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
      // Las tablas de negocio tienen RLS: el mantenimiento recorre los tenants uno a uno.
      const now = new Date();
      let expired = 0;
      let swept = 0;
      const purged = { texts: 0, drafts: 0, photos: 0, events: 0 };
      let tenants: string[] = [];
      try {
        tenants = await allTenantIds(db);
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "housekeeping: ¿falta la migración 0004?",
        );
      }
      for (const tenantId of tenants) {
        await withTenant(db, tenantId, async (tx) => {
          expired += await expirePendingActions(tx, now);
          swept += await sweepOrphanAttachments(
            tx,
            opts.store ?? null,
            tenantId,
            now,
            undefined,
            log,
          );
        });
        // Conservación (/privacidad): texto de los mensajes a los 90 días, fotos a los 12 meses.
        // Aparte, para que un fallo aquí no deshaga lo anterior.
        try {
          const p = await withTenant(db, tenantId, (tx) =>
            purgeOldTenantData(tx, opts.store ?? null, tenantId, now, log),
          );
          purged.texts += p.texts;
          purged.drafts += p.drafts;
          purged.photos += p.photos;
        } catch (err) {
          log.error(
            { tenantId, err: err instanceof Error ? err.message : String(err) },
            "conservación: no se pudo purgar",
          );
        }
      }
      if (expired > 0) log.info({ expired }, "borradores vencidos");
      if (swept > 0) log.info({ swept }, "fotos provisionales borradas");
      try {
        purged.events = await purgeOldWebhookPayloads(db, now);
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "conservación: eventos del webhook",
        );
      }
      if (purged.texts || purged.drafts || purged.photos || purged.events)
        log.info(purged, "conservación: datos viejos borrados");
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
      // Cobros: suspender vencidos (prueba o pago + 3 días de gracia) y avisar límites pasados.
      try {
        const billing = await enforceBilling(db, now);
        if (billing.suspended.length)
          log.warn({ tenants: billing.suspended }, "negocios suspendidos por plan vencido");
        if (billing.errors.length)
          log.error({ errors: billing.errors }, "cobros: negocios con error");
        if (billing.overCap.length) {
          log.warn({ overCap: billing.overCap }, "negocios sobre el límite de mensajes del plan");
          opts.onOverCap?.(billing.overCap);
        }
        if (billing.trialCapped.length) {
          log.warn({ trialCapped: billing.trialCapped }, "pruebas que llegaron a su tope de gasto");
          opts.onTrialCapped?.(billing.trialCapped);
        }
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "cobros: ¿falta la migración 0007?",
        );
      }
      // Retención (0017): avisos de impago, papelera a los 90 días, borrado al vencer la papelera.
      try {
        const sweep = await retentionSweep(db, now, {
          store: opts.store ?? null,
          auth: opts.authAdmin ?? null,
          log,
        });
        if (sweep.purged.length || sweep.trashed.length)
          log.warn({ purged: sweep.purged, trashed: sweep.trashed }, "retención de datos");
        if (sweep.errors.length)
          log.error({ errors: sweep.errors }, "retención: negocios con error");
        if (sweep.notices.length) {
          const meta = opts.platformPhoneNumberId ? deps.metaFor(opts.platformPhoneNumberId) : null;
          const r = await sendRetentionNotices(db, meta, sweep.notices, {
            now,
            dashboardUrl: deps.config.dashboardUrl,
            template: opts.retentionTemplate ?? null,
            log,
          });
          log.info(r, "avisos de borrado por impago");
        }
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "retención: ¿falta la migración 0017?",
        );
      }
      // Pagos revisados en la consola: avisar al dueño por WhatsApp (si escribió en 24 h).
      try {
        const meta = opts.platformPhoneNumberId ? deps.metaFor(opts.platformPhoneNumberId) : null;
        const notices = await sendPaymentNotices(db, meta, {
          now,
          supportHint: deps.config.supportHint,
          log,
        });
        if (notices.sent || notices.skipped) log.info(notices, "avisos de pago");
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "avisos de pago: ¿falta la migración 0011?",
        );
      }
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
