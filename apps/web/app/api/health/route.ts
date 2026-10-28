import { checkHealth } from "@caja/db/health";
import { NextResponse } from "next/server";
import { db, dbRole } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Salud para el monitor externo (runbook, sección 6): 200 si la base responde, el worker terminó
 * un housekeeping hace menos de 15 min y ningún mensaje lleva más de 3 min esperando; 503 si no.
 * Público y sin datos de negocio: solo banderas y edades.
 */
export async function GET() {
  let health: Awaited<ReturnType<typeof checkHealth>>;
  try {
    health = await checkHealth(db());
  } catch {
    health = {
      ok: false,
      db: false,
      worker: { ok: false, lastHousekeepingAt: null, ageSeconds: null },
      queue: { ok: false, waiting: 0, oldestWaitingSeconds: null },
    };
  }
  // Seguridad F6: el rol de la base aísla por negocio (solo la bandera, nunca el usuario).
  const rls = await dbRole()
    .then((r) => r.ok)
    .catch(() => false);
  const ok = health.ok && rls;
  return NextResponse.json(
    { ...health, ok, rls, commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
