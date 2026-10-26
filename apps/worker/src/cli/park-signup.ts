import { type ParkedStep, parkSignup } from "@caja/core";
import { createDb, eq, loadNearestEnvFile, schema } from "@caja/db";

/**
 * Prueba del «hola» (handoff del 26/10): deja un número de prueba con el registro a medias.
 * `pnpm --filter @caja/worker signup:park <número> <accounts|categories> [personal|business] [horas]`
 * Sin paso, solo muestra cómo está el registro de ese número (para revisar después del «hola»).
 * Solo acepta los números de SIGNUP_PARK_NUMBERS (separados por coma, en el .env local).
 */
loadNearestEnvFile();
const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_ADMIN_URL no definida");
  process.exit(2);
}
const [number, step, kind, hours] = process.argv.slice(2);
if (!number || (step && step !== "accounts" && step !== "categories")) {
  console.error("uso: signup:park <número> [accounts|categories] [personal|business] [horas]");
  process.exit(2);
}
// Solo los números internos de la lista (K1). Van en el .env local, nunca en el repo.
const allow = (process.env.SIGNUP_PARK_NUMBERS ?? "")
  .split(",")
  .map((n) => n.replace(/\D/g, ""))
  .filter(Boolean);
if (!allow.includes(number.replace(/\D/g, ""))) {
  console.error("ese número no está en SIGNUP_PARK_NUMBERS");
  process.exit(2);
}
const { db, close } = createDb(url, { max: 1 });

(async () => {
  try {
    if (step)
      await parkSignup(db, {
        e164: number,
        step: step as ParkedStep,
        kind: kind === "business" ? "business" : "personal",
        hoursAgo: hours ? Number(hours) : 7,
      });
    const e164 = number.replace(/\D/g, "");
    const [row] = await db.select().from(schema.signup).where(eq(schema.signup.e164, e164));
    console.log(
      row ? { e164, step: row.step, updatedAt: row.updatedAt, data: row.data } : "sin registro",
    );
  } catch (err) {
    console.error(String(err));
    process.exitCode = 1;
  } finally {
    await close();
  }
})();
