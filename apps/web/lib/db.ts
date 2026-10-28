import "server-only";
import { createDb, type Db } from "@caja/db";
import { type AppRole, appRole } from "@caja/db/health";
import { env } from "./env";

/** Conexión única por proceso. En desarrollo, Next recarga módulos: se guarda en `globalThis`. */
const g = globalThis as unknown as {
  __cajaDb?: ReturnType<typeof createDb>;
  __cajaRole?: Promise<AppRole> | undefined;
};

export function db(): Db {
  // Serverless: pocas conexiones por instancia y que se suelten rápido (pooler de 15 por rol).
  if (!g.__cajaDb) g.__cajaDb = createDb(env().DATABASE_URL, { max: 2, idleTimeoutSec: 20 });
  return g.__cajaDb.db;
}

/** El rol con el que habla la web con la base (seguridad F6), una vez por instancia. */
export function dbRole(): Promise<AppRole> {
  if (!g.__cajaRole)
    g.__cajaRole = appRole(db()).catch((err) => {
      // Un corte de la base no queda guardado: se vuelve a mirar en la próxima petición.
      g.__cajaRole = undefined;
      throw err;
    });
  return g.__cajaRole;
}

/**
 * Seguridad F6: en producción, el panel no atiende si la base no está con `caja_app` sin
 * superusuario ni bypass de RLS (el aislamiento por negocio depende de eso).
 */
export async function assertDbRole(): Promise<void> {
  if (process.env.NODE_ENV !== "production") return;
  const r = await dbRole();
  if (!r.ok)
    throw new Error(
      "La base no está con el rol caja_app (o el rol se salta RLS): el panel no atiende.",
    );
}
