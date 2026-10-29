import { and, type Db, eq, inArray, isNotNull, isNull, or, schema, sql } from "@caja/db";
import { businessDateOf, weekday } from "../domain/dates";
import { isQuietHours } from "../inbox/gate";
import type { MetaClient } from "../whatsapp/client";
import { MetaApiError } from "../whatsapp/client";
import { bumpSignupCounts } from "./signup-counts";
import { SIGNUP_RESCUE_PAYLOADS, signupRescueSettings, stepOf } from "./signup-rescue";

/**
 * (B) El lote único de la plantilla `rocco_registro_pendiente` (PRD signup-reminders v1.2 §4.2,
 * US-SR-08, decisión 3B): por defecto solo cuenta; con `--apply`, una sola corrida en toda la vida
 * del producto, de hasta 30 envíos, uno cada 90 s, la última actividad más reciente primero, y
 * con la regla de parada S1–S7 revisada antes de cada envío.
 *
 * Nada de lo que devuelve o imprime lleva un número o un nombre: solo cuentas.
 */

export const BATCH_CAP = 30;
export const BATCH_MIN_INTERVAL_S = 60;
export const BATCH_DEFAULT_INTERVAL_S = 90;
/** Registro de la corrida única en `app_setting` (audit_log exige un negocio). */
export const BATCH_KEY = "signup_rescue_batch";

/** S3: un solo fallo con uno de estos códigos para la corrida [VERIFICAR con la lista de Meta]. */
export const STOP_CODES = new Set([130429, 131048, 131056, 132015, 132016, 131031, 368, 80007]);
/** Límite de marketing por usuario: se cuenta, no se reintenta y no para la corrida. */
export const PER_USER_LIMIT_CODE = 131049;

export type ExcludeReason =
  | "finished"
  | "internal"
  | "customer"
  | "contact_off"
  | "founder"
  | "rescued"
  | "holdout"
  | "window_open"
  | "too_old";

export type BatchRow = { id: string; e164: string; step: string; updatedAt: Date };

export type BatchPlan = {
  unfinished: number;
  excluded: Record<ExcludeReason, number>;
  eligibleByStep: Record<string, number>;
  eligible: number;
  toSend: number;
  leftOutByCap: number;
  costUsd: number;
  /** Las filas a enviar, la más reciente primero. No se imprimen. */
  rows: BatchRow[];
};

const WINDOW_MS = 24 * 3_600_000;

/** CC-3: A-0031 cubre registros de 30 días o menos; «90» o «abc» se niegan. */
function checkMaxAgeDays(v: number | undefined): number {
  const days = v ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 30)
    throw new BatchRefused("--max-age-days va de 1 a 30 (A-0031)");
  return days;
}
const DAY_MS = 24 * 3_600_000;

/** Quién recibiría la plantilla ahora. `parkNumbers`: los números internos de prueba. */
export async function planSignupBatch(
  db: Db,
  opts: {
    now: Date;
    maxAgeDays?: number;
    parkNumbers?: string[];
    includeHoldout?: boolean;
    rateUsd?: number;
  },
): Promise<BatchPlan> {
  const s = schema.signup;
  const all = await db
    .select({
      id: s.id,
      e164: s.e164,
      step: s.step,
      updatedAt: s.updatedAt,
      completedAt: s.completedAt,
      rescueVia: s.rescueVia,
      contactOffAt: s.contactOffAt,
      founderContactedAt: s.founderContactedAt,
      taken: sql<boolean>`app.phone_is_taken(${s.e164})`,
    })
    .from(s);
  const park = new Set((opts.parkNumbers ?? []).map((n) => n.replace(/\D/g, "")));
  const maxAge = checkMaxAgeDays(opts.maxAgeDays) * DAY_MS;
  const excluded: Record<ExcludeReason, number> = {
    finished: 0,
    internal: 0,
    customer: 0,
    contact_off: 0,
    founder: 0,
    rescued: 0,
    holdout: 0,
    window_open: 0,
    too_old: 0,
  };
  const eligible: BatchRow[] = [];
  let unfinished = 0;
  for (const r of all) {
    const age = opts.now.getTime() - r.updatedAt.getTime();
    const reason: ExcludeReason | null =
      r.completedAt || r.step === "done"
        ? "finished"
        : park.has(r.e164)
          ? "internal"
          : r.taken
            ? "customer"
            : r.contactOffAt
              ? "contact_off"
              : r.founderContactedAt
                ? "founder"
                : r.rescueVia === "window" || r.rescueVia === "template"
                  ? "rescued"
                  : r.rescueVia === "holdout" && !opts.includeHoldout
                    ? "holdout"
                    : age < WINDOW_MS
                      ? "window_open"
                      : age > maxAge
                        ? "too_old"
                        : null;
    if (reason !== "finished") unfinished += 1;
    if (reason) excluded[reason] += 1;
    else eligible.push({ id: r.id, e164: r.e164, step: r.step, updatedAt: r.updatedAt });
  }
  eligible.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const eligibleByStep: Record<string, number> = {};
  for (const r of eligible) {
    const k = stepOf(r.step);
    eligibleByStep[k] = (eligibleByStep[k] ?? 0) + 1;
  }
  const toSend = Math.min(eligible.length, BATCH_CAP);
  return {
    unfinished,
    excluded,
    eligibleByStep,
    eligible: eligible.length,
    toSend,
    leftOutByCap: eligible.length - toSend,
    costUsd: Number((toSend * (opts.rateUsd ?? 0.074)).toFixed(2)),
    rows: eligible.slice(0, toSend),
  };
}

// ---------------------------------------------------------------- calidad (S6)

export type Quality = {
  templateStatus: string | null;
  templateCategory: string | null;
  templateQuality: string | null;
  phoneQuality: string | null;
  messagingLimit: string | null;
};

/** Lo que se pueda leer; lo que no, null («no se pudo leer»). Nunca lanza. */
export async function readQuality(
  meta: MetaClient,
  template: { name: string; wabaId: string | null },
): Promise<Quality> {
  const q: Quality = {
    templateStatus: null,
    templateCategory: null,
    templateQuality: null,
    phoneQuality: null,
    messagingLimit: null,
  };
  if (template.wabaId) {
    try {
      const t = await meta.templateInfo(template.wabaId, template.name);
      q.templateStatus = t?.status ?? null;
      q.templateCategory = t?.category ?? null;
      q.templateQuality = t?.quality_score?.score ?? null;
    } catch {}
  }
  try {
    const p = await meta.phoneNumberFields("quality_rating");
    q.phoneQuality = typeof p.quality_rating === "string" ? p.quality_rating : null;
  } catch {}
  try {
    const p = await meta.phoneNumberFields("whatsapp_business_manager_messaging_limit");
    const v = p.whatsapp_business_manager_messaging_limit;
    q.messagingLimit = v === undefined || v === null ? null : String(v);
  } catch {}
  return q;
}

/** S6: plantilla no aprobada o en amarillo/rojo, o número que no está en verde. */
export function qualityStop(q: Quality): boolean {
  // CC-4: A-0030 y A-0031 cubren la plantilla solo como MARKETING.
  if (q.templateCategory !== null && q.templateCategory.toUpperCase() !== "MARKETING") return true;
  const bad = (v: string | null) => v !== null && /YELLOW|RED|LOW|MEDIUM/i.test(v);
  return (
    (q.templateStatus !== null && q.templateStatus.toUpperCase() !== "APPROVED") ||
    bad(q.templateQuality) ||
    (q.phoneQuality !== null && q.phoneQuality.toUpperCase() !== "GREEN")
  );
}

// ---------------------------------------------------------------- la corrida

export type StopReason = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7";

export type BatchResult = {
  sent: number;
  held: number;
  failedByCode: Record<string, number>;
  optOuts: number;
  stop: StopReason | null;
  unsent: number;
  costUsd: number;
  /** S6 sin poder leer la calidad: se imprime y siguen S1–S5 y S7. */
  qualityUnreadable: boolean;
};

export class BatchRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "BatchRefused";
  }
}

/** Hora de Caracas en minutos desde la medianoche. */
function caracasMinutes(now: Date): number {
  const c = new Date(now.getTime() - 4 * 3_600_000);
  return c.getUTCHours() * 60 + c.getUTCMinutes();
}

/** Martes a jueves, inicio entre 10:00 y 10:45 de Caracas, fuera de la noche. */
export function inStartWindow(now: Date): boolean {
  const d = weekday(businessDateOf(now));
  const m = caracasMinutes(now);
  return d >= 2 && d <= 4 && m >= 600 && m <= 645 && !isQuietHours(now);
}

/** S7: pasan las 11:30 de Caracas o entra la noche. */
function pastEnd(now: Date): boolean {
  return caracasMinutes(now) > 690 || isQuietHours(now);
}

type StoredFailure = { waId: string; code: number | null };

/** Estados `failed` que Meta mandó por webhook para los envíos de esta corrida (P-15). */
async function storedFailures(db: Db, waIds: string[]): Promise<StoredFailure[]> {
  if (!waIds.length) return [];
  const keys = waIds.map((id) => `status:${id}:failed`);
  const rows = await db
    .select({ key: schema.webhookEvent.eventKey, payload: schema.webhookEvent.payload })
    .from(schema.webhookEvent)
    .where(inArray(schema.webhookEvent.eventKey, keys));
  return rows.map((r) => {
    const errors = (r.payload as { errors?: { code?: number | null }[] } | null)?.errors ?? [];
    return { waId: r.key.split(":")[1] ?? "", code: errors[0]?.code ?? null };
  });
}

/**
 * La corrida única. Lanza `BatchRefused` si no se puede empezar (sin enviar nada). Las comprobaciones
 * de parada van antes de cada envío; al parar no se manda nada más.
 */
export async function runSignupBatch(
  db: Db,
  meta: MetaClient,
  opts: {
    template: { name: string; language: string; wabaId: string | null };
    confirm: number | null;
    intervalS?: number;
    maxAgeDays?: number;
    parkNumbers?: string[];
    includeHoldout?: boolean;
    rateUsd?: number;
    now: () => Date;
    sleep: (ms: number) => Promise<void>;
    log?: (line: string) => void;
  },
): Promise<BatchResult> {
  const intervalS = opts.intervalS ?? BATCH_DEFAULT_INTERVAL_S;
  const cfg = await signupRescueSettings(db);
  const start = opts.now();
  if (!cfg.template) throw new BatchRefused("signup_rescue.template está apagado");
  if (opts.includeHoldout && cfg.holdoutPct > 0)
    throw new BatchRefused("--include-holdout no vale mientras holdoutPct > 0");
  // CC-2: «abc» da NaN, y NaN < 60 es falso: sin esto el freno no frenaría.
  if (!Number.isFinite(intervalS) || intervalS < BATCH_MIN_INTERVAL_S)
    throw new BatchRefused(`--interval-s no puede ser menor que ${BATCH_MIN_INTERVAL_S}`);
  if (!inStartWindow(start))
    throw new BatchRefused("solo se empieza de martes a jueves, entre 10:00 y 10:45 de Caracas");
  const plan = await planSignupBatch(db, {
    now: start,
    maxAgeDays: checkMaxAgeDays(opts.maxAgeDays),
    parkNumbers: opts.parkNumbers ?? [],
    includeHoldout: opts.includeHoldout ?? false,
    rateUsd: opts.rateUsd ?? 0.074,
  });
  if (opts.confirm === null || opts.confirm !== plan.toSend)
    throw new BatchRefused(`--confirm tiene que ser ${plan.toSend} (lo que se enviaría ahora)`);
  if (plan.toSend === 0) throw new BatchRefused("no hay nadie a quien enviar");
  // CC-8: el tope de A-0031.
  if (plan.costUsd > 3) throw new BatchRefused("el costo estimado pasa de $3,00 (A-0031)");
  // Una sola corrida en la vida (3B): la fila se crea una vez; un segundo --apply choca aquí.
  const claimed = await db
    .insert(schema.appSetting)
    .values({
      key: BATCH_KEY,
      value: { startedAt: start.toISOString(), toSend: plan.toSend },
      updatedAt: start,
      updatedBy: "signup:rescue",
    })
    .onConflictDoNothing({ target: schema.appSetting.key })
    .returning({ key: schema.appSetting.key });
  if (!claimed.length) throw new BatchRefused("ya hubo una corrida --apply; no hay segunda");

  const s = schema.signup;
  const result: BatchResult = {
    sent: 0,
    held: 0,
    failedByCode: {},
    optOuts: 0,
    stop: null,
    unsent: 0,
    costUsd: 0,
    qualityUnreadable: false,
  };
  const runIds: string[] = [];
  const runWaIds: string[] = [];
  const syncFailures: { code: number | null }[] = [];
  let held = false;
  const log = opts.log ?? (() => {});

  const checkStop = async (index: number): Promise<StopReason | null> => {
    if (!(await signupRescueSettings(db)).template) return "S1";
    if (runIds.length) {
      const offs = await db
        .select({ id: s.id })
        .from(s)
        .where(and(inArray(s.id, runIds), isNotNull(s.contactOffAt)));
      result.optOuts = offs.length;
      if (offs.length >= 2) return "S2";
    }
    const stored = await storedFailures(db, runWaIds);
    const codes = [...syncFailures.map((f) => f.code), ...stored.map((f) => f.code)];
    if (codes.some((c) => c !== null && STOP_CODES.has(c))) return "S3";
    if (held) return "S4";
    if (codes.filter((c) => c !== PER_USER_LIMIT_CODE).length >= 2) return "S5";
    if (index % 5 === 0) {
      const q = await readQuality(meta, opts.template);
      const unreadable =
        q.phoneQuality === null || (q.templateStatus === null && q.templateQuality === null);
      if (unreadable && !result.qualityUnreadable) {
        result.qualityUnreadable = true;
        log("calidad: no se pudo leer todo; siguen S1–S5 y S7");
      }
      if (qualityStop(q)) return "S6";
    }
    if (pastEnd(opts.now())) return "S7";
    return null;
  };

  for (let i = 0; i < plan.rows.length; i++) {
    const row = plan.rows[i] as BatchRow;
    if (i > 0) await opts.sleep(intervalS * 1000);
    const stop = await checkStop(i);
    if (stop) {
      result.stop = stop;
      result.unsent = plan.rows.length - i;
      break;
    }
    const at = opts.now();
    const marked = await db
      .update(s)
      .set({ rescueAt: at, rescueVia: "template" })
      .where(
        and(
          eq(s.id, row.id),
          isNull(s.completedAt),
          isNull(s.contactOffAt),
          isNull(s.founderContactedAt),
          opts.includeHoldout
            ? or(isNull(s.rescueVia), eq(s.rescueVia, "holdout"))
            : isNull(s.rescueVia),
        ),
      )
      .returning({ id: s.id });
    if (!marked.length) continue;
    runIds.push(row.id);
    try {
      const sent = await meta.sendTemplate(
        row.e164,
        opts.template.name,
        opts.template.language,
        [],
        {
          quickReplyPayloads: SIGNUP_RESCUE_PAYLOADS,
        },
      );
      runWaIds.push(sent.waMessageId);
      await db.update(s).set({ rescueWaMessageId: sent.waMessageId }).where(eq(s.id, row.id));
      await bumpSignupCounts(db, at, { template_sends: 1 }).catch(() => {});
      if (sent.messageStatus === "held_for_quality_assessment") {
        result.held += 1;
        held = true;
      } else result.sent += 1;
    } catch (err) {
      const code = err instanceof MetaApiError ? err.code : null;
      syncFailures.push({ code });
      const k = code === null ? "otro" : String(code);
      result.failedByCode[k] = (result.failedByCode[k] ?? 0) + 1;
      // CC-3: la salida va a la agencia; ni siquiera el número enmascarado.
      log(`envío fallido (código ${k})`);
    }
  }
  // Estados `failed` que llegaron por webhook durante la corrida también se cuentan.
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
    .where(eq(schema.appSetting.key, BATCH_KEY));
  return result;
}
