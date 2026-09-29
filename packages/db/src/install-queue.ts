import { PgBoss } from "pg-boss";
import postgres from "postgres";
import { loadNearestEnvFile } from "./env-file.js";
import { PGBOSS_SCHEMA } from "./queue.js";
import { sslFromEnv } from "./ssl.js";

/**
 * Instala o actualiza el schema `pgboss` con el rol administrador y da permisos a `caja_app`.
 * Se corre una vez por entorno y en cada actualización mayor de pg-boss:
 *   DATABASE_ADMIN_URL=... pnpm --filter @caja/db run queue:install
 * El worker arranca luego con `migrate: false`.
 */
export async function installQueue(adminUrl: string, log: (m: string) => void = () => {}) {
  const ssl = sslFromEnv();
  const boss = new PgBoss({
    ...(ssl ? { ssl } : {}),
    connectionString: adminUrl,
    schema: PGBOSS_SCHEMA,
    migrate: true,
    createSchema: true,
    supervise: false,
    schedule: false,
    max: 1,
  });
  await boss.start();
  const version = await boss.schemaVersion();
  await boss.stop({ graceful: false, close: true });
  log(`schema ${PGBOSS_SCHEMA} en versión ${version}`);

  const sql = postgres(adminUrl, { max: 1, onnotice: () => {}, ...(ssl ? { ssl } : {}) });
  try {
    await sql.unsafe(`
      GRANT USAGE ON SCHEMA ${PGBOSS_SCHEMA} TO caja_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${PGBOSS_SCHEMA} TO caja_app;
      GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${PGBOSS_SCHEMA} TO caja_app;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${PGBOSS_SCHEMA} TO caja_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${PGBOSS_SCHEMA} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO caja_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${PGBOSS_SCHEMA} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO caja_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${PGBOSS_SCHEMA} GRANT EXECUTE ON FUNCTIONS TO caja_app;
    `);
    log("permisos otorgados a caja_app");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const isMain =
  process.argv[1]?.endsWith("install-queue.ts") || process.argv[1]?.endsWith("install-queue.js");
if (isMain) {
  loadNearestEnvFile();
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) {
    console.error("DATABASE_ADMIN_URL no definida");
    process.exit(1);
  }
  installQueue(url, console.log).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
