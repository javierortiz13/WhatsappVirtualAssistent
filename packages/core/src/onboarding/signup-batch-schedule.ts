import { and, type Db, eq, schema, sql } from "@caja/db";
import { addDays, businessDateOf, weekday } from "../domain/dates";
import type { MetaClient } from "../whatsapp/client";
import {
  BATCH_CAP,
  BATCH_KEY,
  BatchRefused,
  type BatchResult,
  inStartWindow,
  planSignupBatch,
  runSignupBatch,
} from "./signup-batch";
import { saveSignupRescueSettings } from "./signup-rescue";

/**
 * Lote único de la plantilla del registro, programado desde /admin (decisión del fundador, 05/11):
 * el fundador no está en la computadora a las 10:00. Las mismas reglas de A-0031 que el CLI.
 *
 * - Programar (la noche antes): se guarda la lista exacta de registros que se enviarían ahora (lo
 *   que el fundador ve y confirma), la hora (el próximo martes, miércoles o jueves a las 10:00 de
 *   Caracas) y se enciende «Registro: plantilla (lote)».
 * - El worker mira cada 5 min de 10:00 a 10:45 de martes a jueves; a la hora, corre el lote con
 *   esa lista: salen los que sigan siendo elegibles, uno cada 90 s, con la regla de parada S1–S7.
 *   Apagar el interruptor lo frena antes del próximo envío.
 * - Al terminar (o si no pudo empezar) apaga el interruptor y guarda el resultado, solo cuentas.
 * - Si el worker no lo empezó antes de las 10:45 de ese día, queda «no corrió»: no hay otro día
 *   sin volver a programarlo.
 *
 * Nada de lo que guarda o devuelve lleva un número o un nombre: ids de registro y cuentas.
 */

export const SCHEDULE_KEY = "signup_batch_schedule";
const ACTOR = "lote programado";

/** LB-2: se programa la noche antes (desde las 6 pm), como mucho 16 h antes de la hora. */
export const SCHEDULE_LEAD_MAX_MS = 16 * 3_600_000;
/** LB-5: un lote que sigue «corriendo» 2 h después de su hora se cortó (el worker se cayó). */
export const RUNNING_STALE_MS = 2 * 3_600_000;

const REFUSE = {
  ran: "ya hubo una corrida; no hay segunda",
  scheduled: "ya hay un lote programado",
  lead: "prográmalo la noche antes, desde las 6 pm",
  empty: "no hay nadie a quien enviar",
  cost: "el costo estimado pasa de $3,00 (A-0031)",
} as const;

/**
 * LB-4: los únicos motivos de `scheduleSignupBatch` que /admin muestra tal cual (llegan por la
 * URL); cualquier otro texto se muestra como «revisa el estado».
 */
export const SCHEDULE_REFUSALS: ReadonlySet<string> = new Set(Object.values(REFUSE));

export type BatchScheduleStatus =
  | "scheduled"
  | "running"
  | "done"
  | "cancelled"
  | "missed"
  | "refused";

export type BatchSchedule = {
  status: BatchScheduleStatus;
  /** Inicio programado (ISO). */
  at: string;
  /** Registros confirmados al programar (como mucho 30). */
  ids: string[];
  confirm: number;
  costUsd: number;
  by: string;
  createdAt: string;
  /** Al terminar: solo cuentas. */
  result?: {
    sent: number;
    held: number;
    failed: number;
    optOuts: number;
    unsent: number;
    stop: string | null;
    costUsd: number;
  };
  /** Por qué no corrió o se negó. */
  reason?: string;
  endedAt?: string;
};

/** El próximo martes, miércoles o jueves a las 10:00 de Caracas, después de `now`. */
export function nextBatchSlot(now: Date): Date {
  let day = businessDateOf(now);
  for (let i = 0; i < 8; i++) {
    const wd = weekday(day);
    const at = new Date(`${day}T10:00:00-04:00`);
    if (wd >= 2 && wd <= 4 && at.getTime() > now.getTime()) return at;
    day = addDays(day, 1);
  }
  throw new Error("sin día para el lote");
}

export async function batchSchedule(db: Db): Promise<BatchSchedule | null> {
  const [r] = await db
    .select({ value: schema.appSetting.value })
    .from(schema.appSetting)
    .where(eq(schema.appSetting.key, SCHEDULE_KEY));
  return (r?.value as BatchSchedule | undefined) ?? null;
}

/** ¿Ya hubo una corrida (por el CLI o programada)? A-0031: una sola en la vida. */
export async function batchAlreadyRan(db: Db): Promise<boolean> {
  const [r] = await db
    .select({ key: schema.appSetting.key })
    .from(schema.appSetting)
    .where(eq(schema.appSetting.key, BATCH_KEY));
  return Boolean(r);
}

async function save(db: Db, value: BatchSchedule, now: Date, by: string): Promise<void> {
  await db
    .insert(schema.appSetting)
    .values({ key: SCHEDULE_KEY, value, updatedAt: now, updatedBy: by })
    .onConflictDoUpdate({
      target: schema.appSetting.key,
      set: { value, updatedAt: now, updatedBy: by },
    });
}

/**
 * Programa el lote para el próximo martes a jueves a las 10:00, con quienes saldrían ahora, y
 * enciende «Registro: plantilla (lote)». Se niega (sin cambiar nada) si ya hubo corrida, si ya hay
 * uno programado, si no hay a quién o si pasa de $3,00.
 */
export async function scheduleSignupBatch(
  db: Db,
  opts: { actor: string; now: Date; rateUsd?: number },
): Promise<BatchSchedule> {
  if (await batchAlreadyRan(db)) throw new BatchRefused(REFUSE.ran);
  const current = await batchSchedule(db);
  if (current?.status === "scheduled" || current?.status === "running")
    throw new BatchRefused(REFUSE.scheduled);
  // LB-2: la lista que el fundador confirma no puede tener días de vieja.
  const at = nextBatchSlot(opts.now);
  if (at.getTime() - opts.now.getTime() > SCHEDULE_LEAD_MAX_MS) throw new BatchRefused(REFUSE.lead);
  const plan = await planSignupBatch(db, {
    now: opts.now,
    maxAgeDays: 30,
    parkNumbers: [],
    rateUsd: opts.rateUsd ?? 0.074,
  });
  if (plan.toSend === 0) throw new BatchRefused(REFUSE.empty);
  if (plan.costUsd > 3) throw new BatchRefused(REFUSE.cost);
  const value: BatchSchedule = {
    status: "scheduled",
    at: at.toISOString(),
    ids: plan.rows.map((r) => r.id).slice(0, BATCH_CAP),
    confirm: plan.toSend,
    costUsd: plan.costUsd,
    by: opts.actor,
    createdAt: opts.now.toISOString(),
  };
  await save(db, value, opts.now, opts.actor);
  await saveSignupRescueSettings(db, { template: true }, opts.actor, opts.now);
  return value;
}

/** Cancela el lote programado (si no empezó) y apaga «Registro: plantilla (lote)». */
export async function cancelSignupBatch(db: Db, actor: string, now: Date): Promise<boolean> {
  const current = await batchSchedule(db);
  if (current?.status !== "scheduled") return false;
  await save(db, { ...current, status: "cancelled", endedAt: now.toISOString() }, now, actor);
  await saveSignupRescueSettings(db, { template: false }, actor, now);
  return true;
}

export type ScheduledRun =
  | { ran: false; why: "none" | "not_yet" | "missed" | "taken" | "cut" }
  | { ran: true; result: BatchResult | null; refused: string | null };

/**
 * Una vuelta del worker (cada 5 min, 10:00–10:45, martes a jueves). Corre el lote programado si
 * llegó su hora y está en la franja; lo marca antes de empezar, así dos vueltas no lo corren dos
 * veces. Al terminar, apaga el interruptor.
 */
export async function runScheduledSignupBatch(
  db: Db,
  meta: MetaClient,
  opts: {
    template: { name: string; language: string; wabaId: string | null };
    rateUsd?: number;
    now: () => Date;
    sleep: (ms: number) => Promise<void>;
    log?: (line: string) => void;
  },
): Promise<ScheduledRun> {
  const s = await batchSchedule(db);
  // LB-5: «corriendo» 2 h después de su hora es una corrida cortada (el worker se reinició a
  // mitad): queda terminada y el interruptor apagado. No se retoma (A-0031: una sola corrida).
  if (s?.status === "running") {
    const now = opts.now();
    if (now.getTime() - new Date(s.at).getTime() <= RUNNING_STALE_MS)
      return { ran: false, why: "none" };
    await save(
      db,
      { ...s, status: "done", reason: "se cortó", endedAt: now.toISOString() },
      now,
      ACTOR,
    );
    await saveSignupRescueSettings(db, { template: false }, ACTOR, now);
    return { ran: false, why: "cut" };
  }
  if (s?.status !== "scheduled") return { ran: false, why: "none" };
  const now = opts.now();
  const at = new Date(s.at);
  if (now.getTime() < at.getTime()) return { ran: false, why: "not_yet" };
  if (!inStartWindow(now) || businessDateOf(now) !== businessDateOf(at)) {
    await save(
      db,
      { ...s, status: "missed", reason: "no empezó a tiempo", endedAt: now.toISOString() },
      now,
      ACTOR,
    );
    await saveSignupRescueSettings(db, { template: false }, ACTOR, now);
    return { ran: false, why: "missed" };
  }
  // Se marca antes de empezar: solo una vuelta gana.
  const running: BatchSchedule = { ...s, status: "running" };
  const claimed = await db
    .update(schema.appSetting)
    .set({ value: running, updatedAt: now, updatedBy: ACTOR })
    .where(
      and(
        eq(schema.appSetting.key, SCHEDULE_KEY),
        sql`${schema.appSetting.value}->>'status' = 'scheduled'`,
      ),
    )
    .returning({ key: schema.appSetting.key });
  if (!claimed.length) return { ran: false, why: "taken" };
  let result: BatchResult | null = null;
  let refused: string | null = null;
  try {
    result = await runSignupBatch(db, meta, {
      template: opts.template,
      confirm: null,
      onlyIds: s.ids,
      maxAgeDays: 30,
      parkNumbers: [],
      rateUsd: opts.rateUsd ?? 0.074,
      // LB-1: sin nadie mirando, S6 exige leer la calidad.
      strictQuality: true,
      now: opts.now,
      sleep: opts.sleep,
      ...(opts.log ? { log: opts.log } : {}),
    });
  } catch (err) {
    // Un error inesperado queda como «se negó» (sin datos) y sigue hacia arriba para el log.
    refused = err instanceof BatchRefused ? err.reason : "error inesperado (ver el log del worker)";
    if (!(err instanceof BatchRefused)) throw err;
  } finally {
    const end = opts.now();
    await save(
      db,
      {
        ...running,
        status: refused ? "refused" : "done",
        ...(refused ? { reason: refused } : {}),
        ...(result
          ? {
              result: {
                sent: result.sent,
                held: result.held,
                failed: Object.values(result.failedByCode).reduce((a, b) => a + b, 0),
                optOuts: result.optOuts,
                unsent: result.unsent,
                stop: result.stop,
                costUsd: result.costUsd,
              },
            }
          : {}),
        endedAt: end.toISOString(),
      },
      end,
      ACTOR,
    );
    await saveSignupRescueSettings(db, { template: false }, ACTOR, end);
  }
  return { ran: true, result, refused };
}
