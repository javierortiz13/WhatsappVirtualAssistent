import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Db } from "../client";
import { readAllMigrations } from "../migrate";
import * as schema from "../schema/index";

/**
 * Base de pruebas: Postgres real en WASM con todas las migraciones aplicadas. Corre como
 * superusuario (dueño de las tablas); para probar RLS se hace `SET ROLE caja_app`.
 * El `Db` de PGlite y el de postgres.js comparten la API de Drizzle que usa el código; el cast
 * evita duplicar tipos de driver en el dominio.
 */
export async function createTestDb(): Promise<{ pg: PGlite; db: Db; close: () => Promise<void> }> {
  const pg = new PGlite();
  for (const sql of await readAllMigrations()) {
    await pg.exec(sql);
  }
  const db = drizzle(pg, { schema, casing: "snake_case" }) as unknown as Db;
  return { pg, db, close: () => pg.close() };
}
