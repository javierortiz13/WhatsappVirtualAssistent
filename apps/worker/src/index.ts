import { AnthropicLlmClient, createAgent, type ProcessDeps, stubAgent, whatsapp } from "@caja/core";
import { createDb, rows, sql } from "@caja/db";
import { createBoss, ensureQueues } from "@caja/db/queue";
import { loadEnv } from "./env";
import { registerJobs } from "./jobs";
import { createLogger } from "./logger";
import { captureError, initSentry } from "./sentry";

/**
 * Proceso worker: pg-boss toma los jobs de `process-message` (uno a la vez por teléfono, en
 * orden) y los entrega en lotes al handler. Cada job se procesa de forma idempotente.
 */
async function main() {
  const env = loadEnv();
  const log = createLogger(env.LOG_LEVEL, env.NODE_ENV === "development");
  if (initSentry(env.SENTRY_DSN, env.NODE_ENV)) log.info({}, "sentry activo");
  const { db, close } = createDb(env.DATABASE_URL, { max: 3 });
  const [row] = rows<{ ok: number }>(await db.execute(sql`select 1 as ok`));
  if (row?.ok !== 1) throw new Error("la base no respondió");

  // Un cliente de Meta por número de la plataforma. Hoy uno (del entorno); ADR-001 revisado prevé N.
  const clients = new Map<string, whatsapp.MetaClient>([
    [
      env.META_PHONE_NUMBER_ID,
      new whatsapp.MetaClient({
        accessToken: env.META_ACCESS_TOKEN,
        phoneNumberId: env.META_PHONE_NUMBER_ID,
        graphVersion: env.META_GRAPH_VERSION,
      }),
    ],
  ]);

  // Agente: Claude Sonnet 5.5 si hay clave; si no, el stub (todo fuera de alcance) para no romper.
  const [provider, model] = env.LLM_PRIMARY.split(":");
  const agent =
    env.ANTHROPIC_API_KEY && provider === "anthropic"
      ? createAgent({
          llm: new AnthropicLlmClient({
            apiKey: env.ANTHROPIC_API_KEY,
            ...(model ? { model } : {}),
          }),
          log,
        })
      : stubAgent;
  if (agent === stubAgent)
    log.warn({ provider }, "sin LLM configurado: el agente responde fuera de alcance");

  const deps: ProcessDeps = {
    db,
    metaFor: (id) => clients.get(id) ?? null,
    agent,
    log,
    config: {
      assistantName: env.ASSISTANT_NAME,
      dashboardUrl: env.DASHBOARD_URL,
      supportHint: env.SUPPORT_HINT ?? null,
      unknownReplyMax: 5,
      unknownReplyWindowMs: 60 * 60 * 1000,
      maxEventAgeMs: 12 * 60 * 60 * 1000,
      maxTextLength: 500,
    },
  };

  const boss = createBoss(env.DATABASE_URL, "worker");
  boss.on("error", (err) => {
    log.error({ err: err.message }, "pg-boss");
    captureError(err, { source: "pg-boss" });
  });
  await boss.start();
  await ensureQueues(boss);

  await registerJobs({
    boss,
    db,
    deps,
    log,
    concurrency: env.WORKER_CONCURRENCY,
    onError: (err, queue) => captureError(err, { queue }),
  });

  log.info(
    {
      assistant: env.ASSISTANT_NAME,
      phoneNumberId: env.META_PHONE_NUMBER_ID,
      concurrency: env.WORKER_CONCURRENCY,
      // Railway expone el commit desplegado: permite ver de un vistazo qué versión corre.
      commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
      agent: agent === stubAgent ? "stub" : env.LLM_PRIMARY,
    },
    "worker listo",
  );

  const shutdown = async (signal: string) => {
    log.info({ signal }, "apagando");
    await boss.stop({ graceful: true, timeout: 20_000, close: true });
    await close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  captureError(err, { source: "main" });
  process.exit(1);
});
