import { createDb, sql } from "@caja/db";
import { loadEnv } from "./env.js";
import { createLogger } from "./logger.js";

/**
 * Proceso worker. Día 1: valida entorno, conecta a la base y espera. Día 3 agrega pg-boss,
 * el procesador de mensajes y el cron de tasa BCV.
 */
async function main() {
  const env = loadEnv();
  const log = createLogger(env.LOG_LEVEL, env.NODE_ENV === "development");
  const { db, close } = createDb(env.DATABASE_URL, { max: 3 });

  const [row] = await db.execute<{ ok: number }>(sql`select 1 as ok`);
  if (row?.ok !== 1) throw new Error("la base no respondió");
  log.info({ assistant: env.ASSISTANT_NAME }, "worker listo");

  const shutdown = async (signal: string) => {
    log.info({ signal }, "apagando");
    await close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
