import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { loadNearestEnvFile } from "./env-file.js";
import { sslFromEnv } from "./ssl.js";

/**
 * Migrador mínimo: aplica `migrations/*.sql` en orden alfabético, una transacción por archivo,
 * y registra cada uno en `caja_meta.schema_migrations`. Nunca se edita una migración aplicada.
 */
export async function runMigrations(adminUrl: string, opts: { log?: (m: string) => void } = {}) {
  const log = opts.log ?? (() => {});
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const ssl = sslFromEnv();
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {}, ...(ssl ? { ssl } : {}) });
  try {
    await sql`CREATE SCHEMA IF NOT EXISTS caja_meta`;
    await sql`CREATE TABLE IF NOT EXISTS caja_meta.schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    const applied = new Set(
      (await sql<{ name: string }[]>`SELECT name FROM caja_meta.schema_migrations`).map(
        (r) => r.name,
      ),
    );
    for (const file of files) {
      if (applied.has(file)) continue;
      const body = await readFile(join(dir, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO caja_meta.schema_migrations (name) VALUES (${file})`;
      });
      log(`applied ${file}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Devuelve el SQL de todas las migraciones concatenado, para tests sobre PGlite. */
export async function readAllMigrations(): Promise<string[]> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(files.map((f) => readFile(join(dir, f), "utf8")));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  loadNearestEnvFile();
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) {
    console.error("DATABASE_ADMIN_URL no definida");
    process.exit(1);
  }
  runMigrations(url, { log: console.log })
    .then(() => console.log("migraciones al día"))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
