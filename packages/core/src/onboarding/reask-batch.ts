import {
  and,
  type Db,
  desc,
  eq,
  everyTenantId,
  gt,
  schema,
  sql,
  type Tx,
  withTenant,
} from "@caja/db";
import { isInternalTenant } from "../billing/rewards";
import { businessDateOf } from "../domain/dates";
import { NO_CONTACT_TAG, REASK_TEMPLATE_MARK } from "../inbox/prefs";
import { WINDOW_MS } from "../inbox/window";
import { habitSettings, reengageOn } from "../ledger/habits";
import { tenantBlocked } from "../reminders/deliver";
import { IDS } from "../render/outbound";
import { MetaApiError, type MetaClient } from "../whatsapp/client";
import {
  BATCH_DEFAULT_INTERVAL_S,
  BATCH_KEY,
  BatchRefused,
  inStartWindow,
  PER_USER_LIMIT_CODE,
  pastEnd,
  qualityStop,
  readQuality,
  STOP_CODES,
  type StopReason,
  storedFailures,
} from "./signup-batch";
import {
  batchSchedule,
  nextBatchSlot,
  RUNNING_STALE_MS,
  SCHEDULE_LEAD_MAX_MS,
} from "./signup-batch-schedule";

/**
 * E3-t (retención, agencia 19/11 §7, A-0053): la pregunta de E3 por plantilla
 * (`rocco_pregunta_recordatorio`, MARKETING, sin variables) a los dueños callados, que nunca ven
 * E3-r porque no escriben. Una sola corrida en la vida, con la misma máquina que el lote del
 * registro (A-0031): cuenta y costo en /admin, «Programar lote» la noche antes (16 h o menos) para
 * un martes a jueves a las 10:00, un envío cada 90 s, la calidad leída antes (estricta) y cada 5
 * envíos, la regla de parada S1–S7 y se niega sobre $3,00. Nunca el mismo día que otro lote.
 *
 * A quién (§7.2): el dueño con ≥ 1 movimiento, sin respuesta a ninguna pregunta de E3, al que
 * nunca se le mandó E3-t, con la ventana de 24 h CERRADA (abierta, E3-r lo hace gratis), sin nada
 * apagado ni pendiente ni `no-contactar`, no «interna», no un número de prueba, no empleado,
 * negocio no bloqueado y sin «Le escribí yo» en 7 días. Máximo 30, la actividad más reciente
 * primero. Solo «Sí, recuérdame» lo vuelve elegible para E1.
 *
 * Nada de lo que devuelve, guarda o imprime lleva un número o un nombre: ids y cuentas.
 */

export const REASK_CAP = 30;
export const REASK_MAX_COST_USD = 3;
/** La corrida única (se reclama una vez). */
export const REASK_KEY = "reengage_reask_batch";
/** El lote programado desde /admin. */
export const REASK_SCHEDULE_KEY = "reengage_reask_schedule";
const ACTOR = "lote programado (E3-t)";
/** «Le escribí yo» de los últimos 7 días lo deja fuera. */
const FOUNDER_DAYS_MS = 7 * 86_400_000;

/** Los payloads de E3-t, en orden: Sí, recuérdame · No, gracias · No me escribas. */
export const REASK_PAYLOADS = [
  IDS.pref("reengage_yes"),
  IDS.pref("reengage_no"),
  IDS.pref("yes:all_off"),
];

export type ReaskExclude =
  | "employee"
  | "internal"
  | "test"
  | "blocked"
  | "no_movement"
  | "answered"
  | "already_sent"
  | "opted_out"
  | "no_contact"
  | "pending"
  | "window_open"
  | "founder";

export type ReaskRow = { tenantId: string; phoneId: string; e164: string; lastActivity: Date };

export type ReaskPlan = {
  /** Teléfonos activos mirados (dueños y empleados). */
  phones: number;
  excluded: Record<ReaskExclude, number>;
  eligible: number;
  toSend: number;
  leftOutByCap: number;
  costUsd: number;
  /** Las filas a enviar, la actividad más reciente primero. No se imprimen. */
  rows: ReaskRow[];
};

const emptyExcluded = (): Record<ReaskExclude, number> => ({
  employee: 0,
  internal: 0,
  test: 0,
  blocked: 0,
  no_movement: 0,
  answered: 0,
  already_sent: 0,
  opted_out: 0,
  no_contact: 0,
  pending: 0,
  window_open: 0,
  founder: 0,
});

/** ¿Por qué este teléfono no recibe E3-t ahora? null si es elegible. */
async function reaskReason(
  tx: Tx,
  tenantId: string,
  phone: typeof schema.phoneNumber.$inferSelect,
  now: Date,
  park: Set<string>,
): Promise<{ reason: ReaskExclude | null; lastActivity: Date }> {
  const m = schema.message;
  const [lastIn] = await tx
    .select({ at: m.createdAt })
    .from(m)
    .where(and(eq(m.phoneId, phone.id), eq(m.direction, "in")))
    .orderBy(desc(m.createdAt))
    .limit(1);
  const [mv] = await tx
    .select({
      n: sql<number>`count(*)::int`,
      last: sql<string | null>`max(${schema.movement.createdAt})`,
    })
    .from(schema.movement)
    .where(eq(schema.movement.tenantId, tenantId));
  const lastActivity = new Date(
    Math.max(lastIn?.at.getTime() ?? 0, mv?.last ? new Date(mv.last).getTime() : 0),
  );
  const done = (reason: ReaskExclude | null) => ({ reason, lastActivity });
  if (phone.role !== "owner") return done("employee");
  const [t] = await tx
    .select({ tags: schema.tenant.crmTags })
    .from(schema.tenant)
    .where(eq(schema.tenant.id, tenantId));
  const tags = t?.tags ?? [];
  if (isInternalTenant({ crmTags: tags })) return done("internal");
  if (park.has(phone.e164.replace(/\D/g, ""))) return done("test");
  if (await tenantBlocked(tx, tenantId, now)) return done("blocked");
  if (!mv?.n) return done("no_movement");
  if (phone.reengageOptInAt || phone.reengageDeclinedAt) return done("answered");
  const [sent] = await tx
    .select({ id: m.id })
    .from(m)
    .where(
      and(
        eq(m.phoneId, phone.id),
        eq(m.direction, "out"),
        sql`${m.toolCalls} @> ${JSON.stringify([{ name: REASK_TEMPLATE_MARK }])}::jsonb`,
      ),
    )
    .limit(1);
  if (sent) return done("already_sent");
  if (phone.nudgeOffAt || phone.unsolicitedOffAt) return done("opted_out");
  if (tags.some((g) => g.trim().toLowerCase() === NO_CONTACT_TAG)) return done("no_contact");
  if (phone.prefPending) return done("pending");
  if (lastIn && now.getTime() - lastIn.at.getTime() < WINDOW_MS) return done("window_open");
  // `signup` no es por negocio: se lee en la misma transacción (una sola conexión).
  const [founder] = await tx
    .select({ id: schema.signup.id })
    .from(schema.signup)
    .where(
      and(
        eq(schema.signup.e164, phone.e164),
        gt(schema.signup.founderContactedAt, new Date(now.getTime() - FOUNDER_DAYS_MS)),
      ),
    )
    .limit(1);
  if (founder) return done("founder");
  return done(null);
}

/** Quién recibiría E3-t ahora (la simulación de /admin). `parkNumbers`: números de prueba. */
export async function planReaskBatch(
  db: Db,
  opts: { now: Date; parkNumbers?: string[]; rateUsd?: number; onlyPhoneIds?: string[] },
): Promise<ReaskPlan> {
  const park = new Set((opts.parkNumbers ?? []).map((n) => n.replace(/\D/g, "")));
  const only = opts.onlyPhoneIds ? new Set(opts.onlyPhoneIds) : null;
  const excluded = emptyExcluded();
  const eligible: ReaskRow[] = [];
  let phones = 0;
  for (const tenantId of await everyTenantId(db)) {
    await withTenant(db, tenantId, async (tx) => {
      const list = await tx
        .select()
        .from(schema.phoneNumber)
        .where(
          and(eq(schema.phoneNumber.tenantId, tenantId), eq(schema.phoneNumber.status, "active")),
        );
      for (const phone of list) {
        if (only && !only.has(phone.id)) continue;
        phones += 1;
        const r = await reaskReason(tx, tenantId, phone, opts.now, park);
        if (r.reason) excluded[r.reason] += 1;
        else
          eligible.push({
            tenantId,
            phoneId: phone.id,
            e164: phone.e164,
            lastActivity: r.lastActivity,
          });
      }
    });
  }
  eligible.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
  const toSend = Math.min(eligible.length, REASK_CAP);
  return {
    phones,
    excluded,
    eligible: eligible.length,
    toSend,
    leftOutByCap: eligible.length - toSend,
    costUsd: Number((toSend * (opts.rateUsd ?? 0.074)).toFixed(2)),
    rows: eligible.slice(0, toSend),
  };
}

// ---------------------------------------------------------------- la corrida

export type ReaskResult = {
  sent: number;
  held: number;
  failedByCode: Record<string, number>;
  optOuts: number;
  stop: StopReason | null;
  unsent: number;
  costUsd: number;
};

/** ¿Hubo otro lote ese día de Caracas (el del registro, corrido o programado)? */
async function otherBatchOn(db: Db, day: string): Promise<boolean> {
  const [ran] = await db
    .select({ value: schema.appSetting.value })
    .from(schema.appSetting)
    .where(eq(schema.appSetting.key, BATCH_KEY));
  const started = (ran?.value as { startedAt?: string } | undefined)?.startedAt;
  if (started && businessDateOf(new Date(started)) === day) return true;
  const s = await batchSchedule(db);
  return Boolean(
    s &&
      (s.status === "scheduled" || s.status === "running") &&
      businessDateOf(new Date(s.at)) === day,
  );
}

/**
 * La corrida única de E3-t (siempre programada: sin nadie mirando, la calidad tiene que leerse).
 * Lanza `BatchRefused` si no puede empezar, sin enviar nada.
 */
export async function runReaskBatch(
  db: Db,
  meta: MetaClient,
  opts: {
    template: { name: string; language: string; wabaId: string | null };
    onlyPhoneIds: string[];
    rateUsd?: number;
    intervalS?: number;
    parkNumbers?: string[];
    now: () => Date;
    sleep: (ms: number) => Promise<void>;
    log?: (line: string) => void;
  },
): Promise<ReaskResult> {
  const intervalS = opts.intervalS ?? BATCH_DEFAULT_INTERVAL_S;
  const start = opts.now();
  const log = opts.log ?? (() => {});
  // Una sola corrida en la vida: la segunda se niega antes de mirar nada más.
  if (await reaskAlreadyRan(db))
    throw new BatchRefused("ya hubo una corrida de E3-t; no hay segunda");
  if (!reengageOn(await habitSettings(db)))
    throw new BatchRefused("S1: el recordatorio a su hora (E3) está apagado");
  if (!inStartWindow(start))
    throw new BatchRefused("solo se empieza de martes a jueves, entre 10:00 y 10:45 de Caracas");
  if (await otherBatchOn(db, businessDateOf(start)))
    throw new BatchRefused("ese día ya hay otro lote de plantillas");
  const plan = await planReaskBatch(db, {
    now: start,
    rateUsd: opts.rateUsd ?? 0.074,
    onlyPhoneIds: opts.onlyPhoneIds,
    parkNumbers: opts.parkNumbers ?? [],
  });
  if (plan.toSend === 0) throw new BatchRefused("no hay nadie a quien enviar");
  if (plan.costUsd > REASK_MAX_COST_USD)
    throw new BatchRefused("el costo estimado pasa de $3,00 (A-0053)");
  const q = await readQuality(meta, opts.template);
  if (q.phoneQuality === null || q.templateStatus === null || q.templateCategory === null)
    throw new BatchRefused("S6: no se pudo leer la calidad del número o de la plantilla");
  if (qualityStop(q)) throw new BatchRefused("S6: la calidad o la plantilla no están bien");
  // Una sola corrida en la vida: la fila se crea una vez; una segunda choca aquí.
  const claimed = await db
    .insert(schema.appSetting)
    .values({
      key: REASK_KEY,
      value: { startedAt: start.toISOString(), toSend: plan.toSend },
      updatedAt: start,
      updatedBy: ACTOR,
    })
    .onConflictDoNothing({ target: schema.appSetting.key })
    .returning({ key: schema.appSetting.key });
  if (!claimed.length) throw new BatchRefused("ya hubo una corrida de E3-t; no hay segunda");

  const result: ReaskResult = {
    sent: 0,
    held: 0,
    failedByCode: {},
    optOuts: 0,
    stop: null,
    unsent: 0,
    costUsd: 0,
  };
  const runRows: ReaskRow[] = [];
  const runWaIds: string[] = [];
  const syncFailures: (number | null)[] = [];
  let held = false;

  const checkStop = async (index: number): Promise<StopReason | null> => {
    if (!reengageOn(await habitSettings(db))) return "S1";
    let offs = 0;
    for (const r of runRows)
      offs += await withTenant(db, r.tenantId, async (tx) => {
        const [p] = await tx
          .select({ a: schema.phoneNumber.unsolicitedOffAt, b: schema.phoneNumber.nudgeOffAt })
          .from(schema.phoneNumber)
          .where(eq(schema.phoneNumber.id, r.phoneId));
        return p?.a || p?.b ? 1 : 0;
      });
    result.optOuts = offs;
    if (offs >= 2) return "S2";
    const stored = await storedFailures(db, runWaIds);
    const codes = [...syncFailures, ...stored.map((f) => f.code)];
    if (codes.some((c) => c !== null && STOP_CODES.has(c))) return "S3";
    if (held) return "S4";
    if (codes.filter((c) => c !== PER_USER_LIMIT_CODE).length >= 2) return "S5";
    if (index % 5 === 0) {
      const qq = await readQuality(meta, opts.template);
      if (qq.phoneQuality === null || (qq.templateStatus === null && qq.templateQuality === null))
        return "S6";
      if (qualityStop(qq)) return "S6";
    }
    if (pastEnd(opts.now())) return "S7";
    return null;
  };

  for (let i = 0; i < plan.rows.length; i++) {
    const row = plan.rows[i] as ReaskRow;
    if (i > 0) await opts.sleep(intervalS * 1000);
    const stop = await checkStop(i);
    if (stop) {
      result.stop = stop;
      result.unsent = plan.rows.length - i;
      break;
    }
    const at = opts.now();
    // Se mira de nuevo y se marca antes de enviar (marca, confirma, envía).
    const messageId = await withTenant(db, row.tenantId, async (tx) => {
      const [phone] = await tx
        .select()
        .from(schema.phoneNumber)
        .where(eq(schema.phoneNumber.id, row.phoneId));
      if (!phone) return null;
      const r = await reaskReason(tx, row.tenantId, phone, at, new Set());
      if (r.reason) return null;
      const [m] = await tx
        .insert(schema.message)
        .values({
          tenantId: row.tenantId,
          phoneId: row.phoneId,
          direction: "out",
          kind: "template",
          body: null,
          status: "sending",
          createdAt: at,
          toolCalls: [{ name: REASK_TEMPLATE_MARK, args: { template: opts.template.name } }],
        })
        .returning({ id: schema.message.id });
      return m?.id ?? null;
    });
    if (!messageId) continue;
    runRows.push(row);
    const setStatus = (status: string, waMessageId: string | null = null) =>
      withTenant(db, row.tenantId, (tx) =>
        tx
          .update(schema.message)
          .set({ status, ...(waMessageId ? { waMessageId } : {}) })
          .where(eq(schema.message.id, messageId)),
      );
    try {
      const sent = await meta.sendTemplate(
        row.e164,
        opts.template.name,
        opts.template.language,
        [],
        { quickReplyPayloads: REASK_PAYLOADS },
      );
      runWaIds.push(sent.waMessageId);
      await setStatus("ok", sent.waMessageId);
      if (sent.messageStatus === "held_for_quality_assessment") {
        result.held += 1;
        held = true;
      } else result.sent += 1;
    } catch (err) {
      const code = err instanceof MetaApiError ? err.code : null;
      syncFailures.push(code);
      const k = code === null ? "otro" : String(code);
      result.failedByCode[k] = (result.failedByCode[k] ?? 0) + 1;
      await setStatus(
        err instanceof MetaApiError
          ? code === PER_USER_LIMIT_CODE
            ? "limited"
            : "failed"
          : "unknown",
      );
      // Ni siquiera el número enmascarado: la salida va a la agencia.
      log(`envío fallido (código ${k})`);
    }
  }
  for (const f of await storedFailures(db, runWaIds)) {
    const k = f.code === null ? "otro" : String(f.code);
    result.failedByCode[k] = (result.failedByCode[k] ?? 0) + 1;
  }
  result.costUsd = Number(((result.sent + result.held) * (opts.rateUsd ?? 0.074)).toFixed(2));
  const end = opts.now();
  await db
    .update(schema.appSetting)
    .set({
      value: {
        startedAt: start.toISOString(),
        endedAt: end.toISOString(),
        toSend: plan.toSend,
        sent: result.sent,
        held: result.held,
        failed: Object.values(result.failedByCode).reduce((a, b) => a + b, 0),
        optOuts: result.optOuts,
        stop: result.stop,
      },
      updatedAt: end,
    })
    .where(eq(schema.appSetting.key, REASK_KEY));
  return result;
}

// ---------------------------------------------------------------- programado desde /admin

export const REASK_REFUSE = {
  ran: "ya hubo una corrida de E3-t; no hay segunda",
  scheduled: "ya hay un lote de E3-t programado",
  lead: "prográmalo la noche antes, desde las 6 pm",
  empty: "no hay nadie a quien enviar",
  cost: "el costo estimado pasa de $3,00 (A-0053)",
  off: "el recordatorio a su hora (E3) está apagado",
  other: "ese día ya hay otro lote de plantillas",
} as const;
export const REASK_REFUSALS: ReadonlySet<string> = new Set(Object.values(REASK_REFUSE));

export type ReaskSchedule = {
  status: "scheduled" | "running" | "done" | "cancelled" | "missed" | "refused";
  at: string;
  /** Teléfonos confirmados al programar (como mucho 30). Ids, nunca números. */
  phoneIds: string[];
  confirm: number;
  costUsd: number;
  by: string;
  createdAt: string;
  result?: {
    sent: number;
    held: number;
    failed: number;
    optOuts: number;
    unsent: number;
    stop: string | null;
    costUsd: number;
  };
  reason?: string;
  endedAt?: string;
};

export async function reaskSchedule(db: Db): Promise<ReaskSchedule | null> {
  const [r] = await db
    .select({ value: schema.appSetting.value })
    .from(schema.appSetting)
    .where(eq(schema.appSetting.key, REASK_SCHEDULE_KEY));
  return (r?.value as ReaskSchedule | undefined) ?? null;
}

export async function reaskAlreadyRan(db: Db): Promise<boolean> {
  const [r] = await db
    .select({ key: schema.appSetting.key })
    .from(schema.appSetting)
    .where(eq(schema.appSetting.key, REASK_KEY));
  return Boolean(r);
}

async function save(db: Db, value: ReaskSchedule, now: Date, by: string): Promise<void> {
  await db
    .insert(schema.appSetting)
    .values({ key: REASK_SCHEDULE_KEY, value, updatedAt: now, updatedBy: by })
    .onConflictDoUpdate({
      target: schema.appSetting.key,
      set: { value, updatedAt: now, updatedBy: by },
    });
}

/** ¿Hay un lote de E3-t programado (o corriendo) para ese día de Caracas? */
export async function reaskScheduledOn(db: Db, day: string): Promise<boolean> {
  const s = await reaskSchedule(db);
  return Boolean(
    s &&
      (s.status === "scheduled" || s.status === "running") &&
      businessDateOf(new Date(s.at)) === day,
  );
}

/**
 * «Programar lote» de E3-t: guarda quiénes saldrían ahora y la hora (el próximo martes a jueves a
 * las 10:00). Se niega, sin cambiar nada, si ya hubo corrida, si ya hay uno programado, si falta
 * más de 16 h, si no hay a quién, si pasa de $3,00, con E3 apagado o si ese día hay otro lote.
 */
export async function scheduleReaskBatch(
  db: Db,
  opts: { actor: string; now: Date; rateUsd?: number },
): Promise<ReaskSchedule> {
  if (await reaskAlreadyRan(db)) throw new BatchRefused(REASK_REFUSE.ran);
  const current = await reaskSchedule(db);
  if (current?.status === "scheduled" || current?.status === "running")
    throw new BatchRefused(REASK_REFUSE.scheduled);
  if (!reengageOn(await habitSettings(db))) throw new BatchRefused(REASK_REFUSE.off);
  const at = nextBatchSlot(opts.now);
  if (at.getTime() - opts.now.getTime() > SCHEDULE_LEAD_MAX_MS)
    throw new BatchRefused(REASK_REFUSE.lead);
  if (await otherBatchOn(db, businessDateOf(at))) throw new BatchRefused(REASK_REFUSE.other);
  const plan = await planReaskBatch(db, { now: opts.now, rateUsd: opts.rateUsd ?? 0.074 });
  if (plan.toSend === 0) throw new BatchRefused(REASK_REFUSE.empty);
  if (plan.costUsd > REASK_MAX_COST_USD) throw new BatchRefused(REASK_REFUSE.cost);
  const value: ReaskSchedule = {
    status: "scheduled",
    at: at.toISOString(),
    phoneIds: plan.rows.map((r) => r.phoneId).slice(0, REASK_CAP),
    confirm: plan.toSend,
    costUsd: plan.costUsd,
    by: opts.actor,
    createdAt: opts.now.toISOString(),
  };
  await save(db, value, opts.now, opts.actor);
  return value;
}

export async function cancelReaskBatch(db: Db, actor: string, now: Date): Promise<boolean> {
  const current = await reaskSchedule(db);
  if (current?.status !== "scheduled") return false;
  await save(db, { ...current, status: "cancelled", endedAt: now.toISOString() }, now, actor);
  return true;
}

export type ScheduledReask =
  | { ran: false; why: "none" | "not_yet" | "missed" | "taken" | "cut" | "no_template" }
  | { ran: true; result: ReaskResult | null; refused: string | null };

/** Una vuelta del worker (la misma cola del lote del registro): corre E3-t si llegó su hora. */
export async function runScheduledReaskBatch(
  db: Db,
  meta: MetaClient,
  opts: {
    /** `META_REASK_TEMPLATE`: sin ella no corre (queda «no corrió»). */
    template: { name: string; language: string; wabaId: string | null } | null;
    rateUsd?: number;
    now: () => Date;
    sleep: (ms: number) => Promise<void>;
    log?: (line: string) => void;
  },
): Promise<ScheduledReask> {
  const s = await reaskSchedule(db);
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
    return { ran: false, why: "missed" };
  }
  if (!opts.template) {
    await save(
      db,
      { ...s, status: "refused", reason: "falta META_REASK_TEMPLATE", endedAt: now.toISOString() },
      now,
      ACTOR,
    );
    return { ran: false, why: "no_template" };
  }
  const running: ReaskSchedule = { ...s, status: "running" };
  const claimed = await db
    .update(schema.appSetting)
    .set({ value: running, updatedAt: now, updatedBy: ACTOR })
    .where(
      and(
        eq(schema.appSetting.key, REASK_SCHEDULE_KEY),
        sql`${schema.appSetting.value}->>'status' = 'scheduled'`,
      ),
    )
    .returning({ key: schema.appSetting.key });
  if (!claimed.length) return { ran: false, why: "taken" };
  let result: ReaskResult | null = null;
  let refused: string | null = null;
  try {
    result = await runReaskBatch(db, meta, {
      template: opts.template,
      onlyPhoneIds: s.phoneIds,
      rateUsd: opts.rateUsd ?? 0.074,
      now: opts.now,
      sleep: opts.sleep,
      ...(opts.log ? { log: opts.log } : {}),
    });
  } catch (err) {
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
  }
  return { ran: true, result, refused };
}
