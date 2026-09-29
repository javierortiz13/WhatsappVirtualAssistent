import { PGlite } from "@electric-sql/pglite";
import { readAllMigrations } from "../src/migrate.js";

/** Base de pruebas: Postgres real en WASM con todas las migraciones aplicadas. */
export async function createTestDb() {
  const pg = new PGlite();
  for (const sql of await readAllMigrations()) {
    await pg.exec(sql);
  }
  return pg;
}
