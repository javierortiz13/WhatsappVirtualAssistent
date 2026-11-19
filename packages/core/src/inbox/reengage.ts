import {
  and,
  type Db,
  desc,
  eq,
  everyTenantId,
  gt,
  inArray,
  isNotNull,
  rows,
  schema,
  sql,
  type Tx,
  withTenant,
} from "@caja/db";
import { businessDateOf } from "../domain/dates";
import { habitSettings, reengageOn, reengageTemplateOn, streakFor } from "../ledger/habits";
import { errorText, type Logger, maskPhone, silentLogger } from "../log";
import { qualityStop, readQuality } from "../onboarding/signup-batch";
import { tenantBlocked } from "../reminders/deliver";
import { es, IDS, type Outbound } from "../render/index";
import { MetaApiError, type MetaClient } from "../whatsapp/client";
import { caracasDayStart, type GateDeny, takeUnsolicitedSlot } from "./gate";
import { lifecycleDueToday } from "./lifecycle";
import {
  ignoredInARow,
  NUDGE_EARLY_STEP_MS,
  NUDGE_IGNORED_TO_PAUSE,
  NUDGE_MARK,
  NUDGE_PAUSE_DAYS,
  NUDGE_WINDOW_SAFE_MS,
  pickNightVariant,
  REENGAGE_T_MARK,
} from "./nudge";
import { sendOutbound } from "./process";
import { recordReengageSkips } from "./reengage-stats";
import { caracasMinute, USUAL_DEFAULT, USUAL_MAX, USUAL_MIN, usualMinute } from "./usual-hour";
import { serviceWindow } from "./window";

/**
 * El recordatorio a su hora (retención E1–E3, agencia 19/11, A-0051). Cola `reengage`, cada 5 min
 * de 08:00 a 20:55 de Caracas (la noche la frena la puerta desde las 20:31).
 *
 * A quién: el dueño que dijo «Sí, recuérdame» a E3, E3-n, E3-r o E3-t (`reengage_opt_in_at`), los
 * días sin nada cumplido, de su hora habitual (`reengage_minute`) a una hora después. Una vuelta
 * más tarde no manda nada.
 * - Ventana de 24 h abierta (margen de 10 min): el mensaje de la noche (E2, rotado), como texto
 *   libre, puerta `nudge`, marca `habit_nudge` con `{ v, at_usual: true }`. Si la ventana cierra
 *   antes de su hora, sale en la última vuelta con la ventana abierta, nunca más de 2 h antes.
 * - Ventana cerrada: la plantilla E1 (`reengage_t`), solo con `habits.reengageTemplate`, la
 *   plantilla configurada y un tope mensual (`META_REENGAGE_MONTHLY_CAP_USD`; sin él, ninguna).
 *   Antes de la primera de cada vuelta se lee la calidad (como el lote del registro): sin poder
 *   leerla, o si no está bien, no sale. Máximo 3 seguidas sin un mensaje suyo entre ellas.
 *
 * Una vez al día, en la primera vuelta desde las 08:00, recalcula la hora habitual.
 * La marca va antes de enviar (marca, confirma, envía). Nunca van al log nombres, números sin
 * enmascarar ni textos.
 */

/** Plantillas seguidas sin un mensaje entrante entre ellas: a la 4.ª no sale (`run_done`). */
export const REENGAGE_RUN_MAX = 3;
/** Ventana cerrada antes de su hora: el texto sale antes, pero nunca más de 2 h antes. */
export const REENGAGE_EARLY_MAX_MS = 2 * 3_600_000;
/** Una hora después de su hora, ya no (una vuelta tardía no manda a deshora). */
export const REENGAGE_LATE_MIN = 60;
/** Límite de marketing por usuario de Meta: se cuenta y no se reintenta. */
export const MARKETING_PER_USER_CODE = 131049;
/** Estado del envío que Meta frenó por el límite de marketing por usuario (no es un fallo). */
export const LIMITED_STATUS = "limited";

/** Los payloads de los botones de E1, en orden: Anotar gasto, Hoy no gasté, No me escribas. */
export function reengagePayloads(today: string): string[] {
  return [IDS.menuExpense, IDS.habitNoSpend(today), IDS.pref("yes:all_off")];
}

const STATE_KEY = "reengage_state";
type ReengageState = {
  /** Día de Caracas en que se recalculó la hora habitual. */
  minuteDay?: string;
  /** Día del último aviso a Sentry por el tope. */
  capWarnedDay?: string;
  /** Día en que Meta retuvo una plantilla por calidad: ese día no sale ninguna más. */
  heldDay?: string;
  /** El tope y la tarifa de la última vuelta, para «costo del mes vs tope» en /admin. */
  capUsd?: number | null;
  rateUsd?: number;
};

async function readState(db: Db): Promise<ReengageState> {
  const [r] = await db
    .select({ value: schema.appSetting.value })
    .from(schema.appSetting)
    .where(eq(schema.appSetting.key, STATE_KEY));
  return (r?.value ?? {}) as ReengageState;
}

async function saveState(db: Db, next: ReengageState, now: Date): Promise<void> {
  const value = { ...(await readState(db)), ...next };
  await db
    .insert(schema.appSetting)
    .values({ key: STATE_KEY, value, updatedAt: now, updatedBy: "reengage" })
    .onConflictDoUpdate({ target: schema.appSetting.key, set: { value, updatedAt: now } });
}

/**
 * ¿Le toca ahora, y por dónde? `text`: la ventana está abierta (a su hora, o antes si se cierra
 * antes de su hora); `template`: cerrada, a su hora. null: no es su momento.
 */
export function reengageSlot(v: {
  now: Date;
  usual: number;
  lastInboundAt: Date | null;
}): "text" | "template" | null {
  const m = caracasMinute(v.now);
  const inSlot = m >= v.usual && m <= v.usual + REENGAGE_LATE_MIN;
  const open =
    v.lastInboundAt !== null && v.now.getTime() - v.lastInboundAt.getTime() < NUDGE_WINDOW_SAFE_MS;
  if (!open) return inSlot ? "template" : null;
  if (inSlot) return "text";
  // Como `earlyNudgeDue`: la ventana se cierra antes de su hora; las dos últimas vueltas abiertas.
  const closes = (v.lastInboundAt as Date).getTime() + NUDGE_WINDOW_SAFE_MS;
  const usualAt = caracasDayStart(v.now).getTime() + v.usual * 60_000;
  const left = closes - v.now.getTime();
  return closes <= usualAt &&
    left > 0 &&
    left <= 2 * NUDGE_EARLY_STEP_MS &&
    usualAt - v.now.getTime() <= REENGAGE_EARLY_MAX_MS
    ? "text"
    : null;
}

export type ReengageSkip =
  | GateDeny
  | "kept_today"
  | "not_due"
  | "run_done"
  | "cap_reached"
  | "no_cap"
  | "quality"
  | "held_today"
  | "template_off";

export type ReengageRun = {
  /** Fuera de 08:00–20:55, o con los interruptores apagados: no se miró nada. */
  outside: boolean;
  off: boolean;
  /** Horas habituales recalculadas en esta vuelta (la primera desde las 08:00). */
  minutesUpdated: number;
  /** Textos dentro de la ventana, plantillas E1 enviadas y retenidas por calidad. */
  text: number;
  templates: number;
  held: number;
  failed: number;
  failedByCode: Record<string, number>;
  paused: number;
  skipped: Partial<Record<ReengageSkip, number>>;
};

type Owner = {
  id: string;
  e164: string;
  optIn: Date | null;
  reengageAt: Date;
  minute: number | null;
  pausedUntil: Date | null;
};

type Pending = { phoneId: string; e164: string; messageId: string; out: Outbound | null };

async function ownerOf(tx: Tx, tenantId: string): Promise<Owner | null> {
  const p = schema.phoneNumber;
  const [o] = await tx
    .select({
      id: p.id,
      e164: p.e164,
      optIn: p.nudgeOptInAt,
      reengageAt: p.reengageOptInAt,
      minute: p.reengageMinute,
      pausedUntil: p.nudgePausedUntil,
    })
    .from(p)
    .where(
      and(
        eq(p.tenantId, tenantId),
        eq(p.role, "owner"),
        eq(p.status, "active"),
        isNotNull(p.reengageOptInAt),
      ),
    )
    .limit(1);
  return o?.e164 && o.reengageAt ? (o as Owner) : null;
}

/** Plantillas E1 que salieron (o quizá salieron) desde el último mensaje suyo: la corrida. */
export async function templatesInRun(tx: Tx, phoneId: string, since: Date): Promise<number> {
  const m = schema.message;
  const [lastIn] = await tx
    .select({ at: m.createdAt })
    .from(m)
    .where(and(eq(m.phoneId, phoneId), eq(m.direction, "in")))
    .orderBy(desc(m.createdAt))
    .limit(1);
  const from = new Date(Math.max(lastIn?.at.getTime() ?? 0, since.getTime() - 1));
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(m)
    .where(
      and(
        eq(m.phoneId, phoneId),
        eq(m.direction, "out"),
        inArray(m.status, ["ok", "unknown", "sending"]),
        gt(m.createdAt, from),
        sql`${m.toolCalls} @> ${JSON.stringify([{ name: REENGAGE_T_MARK }])}::jsonb`,
      ),
    );
  return r?.n ?? 0;
}

/**
 * Plantillas E1 de este negocio en el mes de Caracas de `now` que cuentan para el tope: las
 * enviadas y las retenidas (y, por las dudas, las que quizá salieron o se cortaron al enviarse).
 */
export async function monthTemplates(tx: Tx, tenantId: string, now: Date): Promise<number> {
  const first = `${businessDateOf(now).slice(0, 8)}01`;
  const [r] = rows<{ n: number }>(
    await tx.execute(sql`
      select count(*)::int as n from app.message
      where tenant_id = ${tenantId} and direction = 'out'
        and status in ('ok', 'unknown', 'sending')
        and tool_calls @> ${JSON.stringify([{ name: REENGAGE_T_MARK }])}::jsonb
        and created_at >= (${first}::date::timestamp at time zone 'America/Caracas')
    `),
  );
  return r?.n ?? 0;
}

/** US-208 con E1: 3 avisos o plantillas seguidos sin un día cumplido → 14 días en pausa. */
async function autoPause(tx: Tx, tenantId: string, o: Owner, now: Date): Promise<boolean> {
  const since = new Date(
    Math.max(o.optIn?.getTime() ?? 0, o.pausedUntil?.getTime() ?? 0, o.reengageAt.getTime()),
  );
  if ((await ignoredInARow(tx, tenantId, o.id, since, now)) < NUDGE_IGNORED_TO_PAUSE) return false;
  const until = new Date(now.getTime() + NUDGE_PAUSE_DAYS * 86_400_000);
  await tx
    .update(schema.phoneNumber)
    .set({ nudgePausedUntil: until })
    .where(eq(schema.phoneNumber.id, o.id));
  await tx.insert(schema.auditLog).values({
    tenantId,
    actorType: "system",
    actorId: null,
    action: "nudge_auto_pause",
    entity: "phone_number",
    entityId: o.id,
    after: { paused_until: until.toISOString(), ignored: NUDGE_IGNORED_TO_PAUSE },
    channel: "whatsapp",
  });
  return true;
}

type Step =
  | { kind: "skip"; why: ReengageSkip; phoneId: string }
  | { kind: "paused" }
  | { kind: "text"; pending: Pending }
  | { kind: "template"; phoneId: string };

/** Primera mirada (dentro del negocio): ¿le toca?, y si es texto, lo marca. */
async function firstLook(
  tx: Tx,
  tenantId: string,
  now: Date,
  flags: { noSpend: boolean; nightRotation: boolean },
): Promise<Step | null> {
  const o = await ownerOf(tx, tenantId);
  if (!o) return null;
  const minute = o.minute ?? USUAL_DEFAULT;
  const win = await serviceWindow(tx, o.id, now);
  const slot = reengageSlot({ now, usual: minute, lastInboundAt: win.lastInboundAt });
  const skip = (why: ReengageSkip): Step => ({ kind: "skip", why, phoneId: o.id });
  if (!slot) return skip("not_due");
  if (o.pausedUntil && o.pausedUntil.getTime() > now.getTime()) return skip("paused");
  if (await autoPause(tx, tenantId, o, now)) return { kind: "paused" };
  const streak = await streakFor(tx, tenantId, now);
  if (streak.keptToday) return skip("kept_today");
  if (slot === "template") return { kind: "template", phoneId: o.id };
  const gate = await takeUnsolicitedSlot(tx, {
    tenantId,
    phoneId: o.id,
    kind: "nudge",
    now,
    tenantBlocked: await tenantBlocked(tx, tenantId, now),
    lifecycleDueToday: await lifecycleDueToday(tx, tenantId, now),
    windowSafeMs: NUDGE_WINDOW_SAFE_MS,
  });
  if (!gate.allow) return skip(gate.reason);
  const [t] = await tx
    .select({ businessType: schema.tenant.businessType })
    .from(schema.tenant)
    .where(eq(schema.tenant.id, tenantId));
  const personal = t?.businessType === "personal";
  const variant = flags.nightRotation ? await pickNightVariant(tx, o.id) : "N1";
  const today = businessDateOf(now);
  const out = es.habitNudge({
    current: streak.current,
    best: streak.best,
    personal,
    noSpendDate: flags.noSpend ? today : null,
    variant,
  });
  const [row] = await tx
    .insert(schema.message)
    .values({
      tenantId,
      phoneId: o.id,
      direction: "out",
      kind: out.type,
      body: out.type === "reaction" ? null : out.body,
      status: "sending",
      createdAt: now,
      toolCalls: [{ name: NUDGE_MARK, args: { n: streak.current, v: variant, at_usual: true } }],
    })
    .returning({ id: schema.message.id });
  if (!row) return null;
  return { kind: "text", pending: { phoneId: o.id, e164: o.e164, messageId: row.id, out } };
}

/** Segunda mirada (la plantilla ya tiene calidad y tope): corrida, puerta y la marca. */
async function takeTemplate(
  tx: Tx,
  tenantId: string,
  now: Date,
  template: string,
): Promise<{ kind: "skip"; why: ReengageSkip } | { kind: "go"; pending: Pending } | null> {
  const o = await ownerOf(tx, tenantId);
  if (!o) return null;
  if ((await templatesInRun(tx, o.id, o.reengageAt)) >= REENGAGE_RUN_MAX)
    return { kind: "skip", why: "run_done" };
  const gate = await takeUnsolicitedSlot(tx, {
    tenantId,
    phoneId: o.id,
    kind: "reengage_t",
    now,
    tenantBlocked: await tenantBlocked(tx, tenantId, now),
    lifecycleDueToday: await lifecycleDueToday(tx, tenantId, now),
  });
  if (!gate.allow) return { kind: "skip", why: gate.reason };
  const [row] = await tx
    .insert(schema.message)
    .values({
      tenantId,
      phoneId: o.id,
      direction: "out",
      kind: "template",
      body: null,
      status: "sending",
      createdAt: now,
      toolCalls: [{ name: REENGAGE_T_MARK, args: { template } }],
    })
    .returning({ id: schema.message.id });
  if (!row) return null;
  return { kind: "go", pending: { phoneId: o.id, e164: o.e164, messageId: row.id, out: null } };
}

export type ReengageOpts = {
  now: Date;
  log?: Logger;
  /** La plantilla E1 (`META_REENGAGE_TEMPLATE`) con su cuenta, para leer la calidad. */
  template?: { name: string; language: string; wabaId: string | null } | null;
  /** `META_REENGAGE_MONTHLY_CAP_USD`: sin él no sale ninguna plantilla. */
  capUsd?: number | null;
  /** `META_MARKETING_RATE_USD`. */
  rateUsd?: number;
  /** Un aviso al día (Sentry, sin datos) cuando el tope frena una plantilla. */
  onCapReached?: (r: { monthTemplates: number; capUsd: number }) => void;
  /** Meta retuvo una plantilla por calidad (Sentry, sin datos): ese día no sale ninguna más. */
  onHeld?: () => void;
};

/** Una vuelta de la cola `reengage`. Sin `habits.reengageAsk` (con `nudge` y `prefs`), nada. */
export async function runReengage(
  db: Db,
  meta: MetaClient | null,
  opts: ReengageOpts,
): Promise<ReengageRun> {
  const log = opts.log ?? silentLogger;
  const now = opts.now;
  const run: ReengageRun = {
    outside: false,
    off: false,
    minutesUpdated: 0,
    text: 0,
    templates: 0,
    held: 0,
    failed: 0,
    failedByCode: {},
    paused: 0,
    skipped: {},
  };
  const skips: { phoneId: string; reason: ReengageSkip }[] = [];
  const skip = (why: ReengageSkip, phoneId?: string) => {
    run.skipped[why] = (run.skipped[why] ?? 0) + 1;
    if (phoneId) skips.push({ phoneId, reason: why });
  };
  if (!meta) return { ...run, off: true };
  const flags = await habitSettings(db);
  if (!reengageOn(flags)) return { ...run, off: true };
  const m = caracasMinute(now);
  if (m < USUAL_MIN || m > USUAL_MAX + REENGAGE_LATE_MIN) return { ...run, outside: true };
  const today = businessDateOf(now);
  const state = await readState(db);
  const tenants = await everyTenantId(db);
  // La hora habitual, una vez al día en la primera vuelta desde las 08:00.
  if (state.minuteDay !== today) {
    for (const tenantId of tenants) {
      try {
        run.minutesUpdated += await withTenant(db, tenantId, async (tx) => {
          const o = await ownerOf(tx, tenantId);
          if (!o) return 0;
          const minute = await usualMinute(tx, tenantId, now);
          await tx
            .update(schema.phoneNumber)
            .set({ reengageMinute: minute })
            .where(eq(schema.phoneNumber.id, o.id));
          return 1;
        });
      } catch (err) {
        log.error({ err: errorText(err) }, "recordatorio a su hora: hora habitual");
      }
    }
    await saveState(db, { minuteDay: today }, now);
  }
  if (state.capUsd !== (opts.capUsd ?? null) || state.rateUsd !== (opts.rateUsd ?? 0.074))
    await saveState(db, { capUsd: opts.capUsd ?? null, rateUsd: opts.rateUsd ?? 0.074 }, now);

  // Lo de la plantilla se decide una vez por vuelta, cuando hace falta la primera.
  let templateReady: ReengageSkip | true | null = null;
  let monthCount = 0;
  const rate = opts.rateUsd ?? 0.074;
  const tpl = opts.template ?? null;
  const prepareTemplate = async (): Promise<ReengageSkip | true> => {
    if (!reengageTemplateOn(flags) || !tpl) return "template_off";
    if (opts.capUsd === null || opts.capUsd === undefined || !(opts.capUsd > 0)) return "no_cap";
    if (state.heldDay === today) return "held_today";
    // Antes de la primera plantilla de la vuelta (como el lote del registro, LB-1): sin leerla
    // completa, o si no está bien, no sale.
    const q = await readQuality(meta, { name: tpl.name, wabaId: tpl.wabaId });
    if (q.phoneQuality === null || q.templateStatus === null || q.templateCategory === null)
      return "quality";
    if (qualityStop(q)) return "quality";
    for (const tenantId of tenants)
      monthCount += await withTenant(db, tenantId, (tx) => monthTemplates(tx, tenantId, now));
    return true;
  };

  for (const tenantId of tenants) {
    try {
      const step = await withTenant(db, tenantId, (tx) => firstLook(tx, tenantId, now, flags));
      if (!step) continue;
      if (step.kind === "skip") {
        skip(step.why, step.phoneId);
        continue;
      }
      if (step.kind === "paused") {
        run.paused += 1;
        continue;
      }
      let p: Pending;
      if (step.kind === "text") p = step.pending;
      else {
        if (templateReady === null) templateReady = await prepareTemplate();
        if (templateReady !== true) {
          skip(templateReady, step.phoneId);
          continue;
        }
        const cap = opts.capUsd as number;
        // Tope duro: (las del mes + esta) × tarifa > tope → no sale.
        if ((monthCount + 1) * rate > cap + 1e-9) {
          skip("cap_reached", step.phoneId);
          if (state.capWarnedDay !== today) {
            state.capWarnedDay = today;
            await saveState(db, { capWarnedDay: today }, now);
            opts.onCapReached?.({ monthTemplates: monthCount, capUsd: cap });
          }
          continue;
        }
        const t = await withTenant(db, tenantId, (tx) =>
          takeTemplate(tx, tenantId, now, (tpl as { name: string }).name),
        );
        if (!t) continue;
        if (t.kind === "skip") {
          skip(t.why, step.phoneId);
          continue;
        }
        p = t.pending;
        monthCount += 1;
      }
      // La marca de la plantilla guarda si Meta la retuvo o el código del fallo (solo eso).
      const status = (
        s: string,
        waMessageId: string | null = null,
        extra: { held?: true; code?: number | null } | null = null,
      ) =>
        withTenant(db, tenantId, (tx) =>
          tx
            .update(schema.message)
            .set({
              status: s,
              ...(waMessageId ? { waMessageId } : {}),
              ...(extra && tpl
                ? { toolCalls: [{ name: REENGAGE_T_MARK, args: { template: tpl.name, ...extra } }] }
                : {}),
            })
            .where(eq(schema.message.id, p.messageId)),
        );
      try {
        if (p.out) {
          const r = await sendOutbound(meta, p.e164, p.out);
          await status("ok", r.waMessageId);
          run.text += 1;
        } else {
          const t = tpl as { name: string; language: string };
          const r = await meta.sendTemplate(p.e164, t.name, t.language, [], {
            quickReplyPayloads: reengagePayloads(today),
          });
          const held = r.messageStatus === "held_for_quality_assessment";
          await status("ok", r.waMessageId, held ? { held: true } : null);
          if (held) {
            // Meta la retuvo por calidad: la cola para ese día y avisa.
            run.held += 1;
            templateReady = "held_today";
            state.heldDay = today;
            await saveState(db, { heldDay: today }, now);
            opts.onHeld?.();
          } else run.templates += 1;
        }
      } catch (err) {
        const code = err instanceof MetaApiError ? err.code : null;
        if (!p.out) {
          monthCount -= 1;
          const k = code === null ? "otro" : String(code);
          run.failedByCode[k] = (run.failedByCode[k] ?? 0) + 1;
        }
        run.failed += 1;
        // Meta respondió: no salió. 131049 (límite de marketing por usuario): se cuenta, no se
        // reintenta (la marca ya ocupa el día) y no cuenta como fallo de la puerta. Sin respuesta
        // (red): no se sabe, no se repite.
        await status(
          err instanceof MetaApiError
            ? !p.out && code === MARKETING_PER_USER_CODE
              ? LIMITED_STATUS
              : "failed"
            : "unknown",
          null,
          p.out ? null : { code },
        );
        log.warn(
          { to: maskPhone(p.e164), code, via: p.out ? "text" : "template" },
          "recordatorio a su hora no enviado",
        );
      }
    } catch (err) {
      log.error({ err: errorText(err) }, "recordatorio a su hora");
    }
  }
  try {
    await recordReengageSkips(db, now, skips);
  } catch (err) {
    log.error({ err: errorText(err) }, "recordatorio a su hora: saltos");
  }
  return run;
}
