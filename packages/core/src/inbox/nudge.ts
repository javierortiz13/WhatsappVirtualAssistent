import {
  and,
  type Db,
  desc,
  eq,
  everyTenantId,
  gt,
  lt,
  schema,
  sql,
  type Tx,
  withTenant,
} from "@caja/db";
import { businessDateOf } from "../domain/dates";
import { habitSettings, keptDays, streakFor } from "../ledger/habits";
import { errorText, type Logger, maskPhone, silentLogger } from "../log";
import { tenantBlocked } from "../reminders/deliver";
import { es, type Outbound } from "../render/index";
import { MetaApiError, type MetaClient } from "../whatsapp/client";
import { caracasDayStart, type GateDeny, takeUnsolicitedSlot } from "./gate";
import { lifecycleDueToday } from "./lifecycle";
import { sendOutbound } from "./process";

/**
 * El aviso de las 8 pm (PRD hábitos US-207, US-208). La cola `habit-nudges` corre a las 20:00 de
 * Caracas; como resguardo, solo actúa de 20:00 a 20:29 (un reintento tardío no manda nada).
 *
 * A quién: el teléfono dueño que aceptó el aviso, con 2 días de racha o más y nada anotado hoy
 * (un día sin gastos cuenta), si la puerta (US-203, `kind = nudge`) lo deja. Un mensaje, sin la IA.
 * La marca `habit_nudge` se escribe y se confirma antes de enviar: dos corridas el mismo día no
 * mandan dos avisos (la puerta ve la marca). Si Meta lo rechaza, la fila queda en `failed` y la
 * puerta no le vuelve a escribir en 7 días.
 *
 * Pausa (US-208): 3 avisos seguidos sin un día cumplido → 14 días en pausa, en silencio.
 *
 * Nunca van al log nombres, números sin enmascarar ni texto.
 */

export const NUDGE_MARK = "habit_nudge";
/** Avisos seguidos sin un día cumplido que ponen el aviso en pausa (US-208). */
export const NUDGE_IGNORED_TO_PAUSE = 3;
export const NUDGE_PAUSE_DAYS = 14;

/** De 20:00 a 20:29 de Caracas (US-207). */
export function inNudgeWindow(now: Date): boolean {
  const caracas = new Date(now.getTime() - 4 * 3_600_000);
  return caracas.getUTCHours() === 20 && caracas.getUTCMinutes() < 30;
}

export type NudgeRun = {
  sent: number;
  failed: number;
  paused: number;
  /** Por qué no salió, solo cuentas. */
  skipped: Partial<Record<GateDeny | "not_opted_in" | "short_streak" | "kept_today", number>>;
  /** Corrida fuera de 20:00–20:29: no se miró nada. */
  outside: boolean;
};

type Pending = { phoneId: string; e164: string; messageId: string; out: Outbound };

/**
 * Avisos seguidos, del más reciente hacia atrás, cuyo día terminó sin nada cumplido. Solo los
 * enviados desde `since` (la última aceptación o el fin de la última pausa) y antes de hoy.
 */
export async function ignoredInARow(
  tx: Tx,
  tenantId: string,
  phoneId: string,
  since: Date,
  now: Date,
): Promise<number> {
  const m = schema.message;
  const sent = await tx
    .select({ at: m.createdAt })
    .from(m)
    .where(
      and(
        eq(m.phoneId, phoneId),
        eq(m.direction, "out"),
        eq(m.status, "ok"),
        gt(m.createdAt, since),
        lt(m.createdAt, caracasDayStart(now)),
        sql`${m.toolCalls} @> ${JSON.stringify([{ name: NUDGE_MARK }])}::jsonb`,
      ),
    )
    .orderBy(desc(m.createdAt))
    .limit(NUDGE_IGNORED_TO_PAUSE * 2);
  if (!sent.length) return 0;
  const kept = await keptDays(tx, tenantId);
  const days = [...new Set(sent.map((r) => businessDateOf(r.at)))];
  let n = 0;
  for (const d of days) {
    if (kept.has(d)) break;
    n += 1;
  }
  return n;
}

async function takeNudge(
  tx: Tx,
  tenantId: string,
  now: Date,
  noSpendButton: boolean,
  run: NudgeRun,
): Promise<Pending | null> {
  const skip = (why: keyof NudgeRun["skipped"]) => {
    run.skipped[why] = (run.skipped[why] ?? 0) + 1;
    return null;
  };
  const p = schema.phoneNumber;
  const [owner] = await tx
    .select({
      id: p.id,
      e164: p.e164,
      optIn: p.nudgeOptInAt,
      off: p.nudgeOffAt,
      pausedUntil: p.nudgePausedUntil,
    })
    .from(p)
    .where(and(eq(p.tenantId, tenantId), eq(p.role, "owner"), eq(p.status, "active")))
    .limit(1);
  if (!owner?.e164) return null;
  // Sin aceptar no se mira más (la puerta lo negaría igual): la mayoría de los negocios.
  if (!owner.optIn || owner.off) return skip("not_opted_in");
  if (owner.pausedUntil && owner.pausedUntil.getTime() > now.getTime()) return skip("paused");
  // US-208: se cuentan los avisos desde la aceptación o desde que terminó la última pausa.
  const since =
    owner.pausedUntil && owner.pausedUntil.getTime() > owner.optIn.getTime()
      ? owner.pausedUntil
      : owner.optIn;
  if ((await ignoredInARow(tx, tenantId, owner.id, since, now)) >= NUDGE_IGNORED_TO_PAUSE) {
    const until = new Date(now.getTime() + NUDGE_PAUSE_DAYS * 86_400_000);
    await tx.update(p).set({ nudgePausedUntil: until }).where(eq(p.id, owner.id));
    await tx.insert(schema.auditLog).values({
      tenantId,
      actorType: "system",
      actorId: null,
      action: "nudge_auto_pause",
      entity: "phone_number",
      entityId: owner.id,
      after: { paused_until: until.toISOString(), ignored: NUDGE_IGNORED_TO_PAUSE },
      channel: "whatsapp",
    });
    run.paused += 1;
    return null;
  }
  const streak = await streakFor(tx, tenantId, now);
  if (streak.keptToday) return skip("kept_today");
  if (streak.current < 2) return skip("short_streak");
  const gate = await takeUnsolicitedSlot(tx, {
    tenantId,
    phoneId: owner.id,
    kind: "nudge",
    now,
    tenantBlocked: await tenantBlocked(tx, tenantId, now),
    // Un aviso de la prueba que sale más tarde hoy se queda con el día (F-1).
    lifecycleDueToday: await lifecycleDueToday(tx, tenantId, now),
  });
  if (!gate.allow) return skip(gate.reason);
  const [t] = await tx
    .select({ businessType: schema.tenant.businessType })
    .from(schema.tenant)
    .where(eq(schema.tenant.id, tenantId));
  const out = es.habitNudge({
    current: streak.current,
    best: streak.best,
    personal: t?.businessType === "personal",
    noSpendDate: noSpendButton ? businessDateOf(now) : null,
  });
  // La marca va antes de enviar y se confirma con esta transacción.
  const [row] = await tx
    .insert(schema.message)
    .values({
      tenantId,
      phoneId: owner.id,
      direction: "out",
      kind: out.type,
      body: out.body,
      status: "sending",
      createdAt: now,
      toolCalls: [{ name: NUDGE_MARK, args: { n: streak.current } }],
    })
    .returning({ id: schema.message.id });
  if (!row) return null;
  return { phoneId: owner.id, e164: owner.e164, messageId: row.id, out };
}

/** Una corrida de la cola `habit-nudges`. Sin `habits.nudge` (y `prefs`), no hace nada. */
export async function runHabitNudges(
  db: Db,
  meta: MetaClient | null,
  opts: { now: Date; log?: Logger },
): Promise<NudgeRun> {
  const log = opts.log ?? silentLogger;
  const now = opts.now;
  const run: NudgeRun = { sent: 0, failed: 0, paused: 0, skipped: {}, outside: false };
  if (!meta) return run;
  const flags = await habitSettings(db);
  // Sin «apagar y encender avisos», el «No me recuerdes» del aviso no funcionaría.
  if (!flags.nudge || !flags.prefs) return run;
  if (!inNudgeWindow(now)) return { ...run, outside: true };
  for (const tenantId of await everyTenantId(db)) {
    try {
      const p = await withTenant(db, tenantId, (tx) =>
        takeNudge(tx, tenantId, now, flags.noSpend, run),
      );
      if (!p) continue;
      const status = (s: "ok" | "failed" | "unknown", waMessageId: string | null = null) =>
        withTenant(db, tenantId, (tx) =>
          tx
            .update(schema.message)
            .set({ status: s, ...(waMessageId ? { waMessageId } : {}) })
            .where(eq(schema.message.id, p.messageId)),
        );
      try {
        const r = await sendOutbound(meta, p.e164, p.out);
        await status("ok", r.waMessageId);
        run.sent += 1;
      } catch (err) {
        run.failed += 1;
        // Meta respondió: no salió (N-4). Sin respuesta (red): no se sabe, no se repite.
        await status(err instanceof MetaApiError ? "failed" : "unknown");
        log.warn(
          {
            to: maskPhone(p.e164),
            code: err instanceof MetaApiError ? err.code : null,
          },
          "aviso de racha no enviado",
        );
      }
    } catch (err) {
      log.error({ err: errorText(err) }, "aviso de racha");
    }
  }
  return run;
}

// ---------------------------------------------------------------- números (US-209, /admin)

/** Conteos del aviso de un negocio desde `since`. Solo números: ni textos ni teléfonos. */
export type NudgeStats = {
  /** Ofertas H7 mostradas en una tarjeta. */
  offers: number;
  /** Aceptaciones por el botón H8 y por la frase o el panel. */
  optInsButton: number;
  optInsOther: number;
  /** Teléfonos dueños con el aviso aceptado y encendido ahora, y de esos, en pausa. */
  optedIn: number;
  paused: number;
  sent: number;
  failed: number;
  /** Avisos seguidos de un día cumplido (anotó, o «hoy no gasté nada»). */
  answered: number;
  /** Días sin gastos marcados con el botón del aviso (US-212). */
  noSpendButton: number;
  autoPauses: number;
};

export async function nudgeStats(
  tx: Tx,
  tenantId: string,
  since: Date,
  now: Date,
): Promise<NudgeStats> {
  const m = schema.message;
  const marked = (name: string) => sql`${m.toolCalls} @> ${JSON.stringify([{ name }])}::jsonb`;
  const outs = await tx
    .select({ at: m.createdAt, status: m.status, toolCalls: m.toolCalls })
    .from(m)
    .where(
      and(
        eq(m.tenantId, tenantId),
        eq(m.direction, "out"),
        gt(m.createdAt, since),
        sql`(${marked(NUDGE_MARK)} or ${marked("habit_optin_offer")} or ${marked("habit_no_spend")})`,
      ),
    );
  const has = (tc: unknown, name: string, args?: Record<string, unknown>) =>
    Array.isArray(tc) &&
    tc.some(
      (c: { name?: string; args?: Record<string, unknown> }) =>
        c.name === name && (!args || Object.entries(args).every(([k, v]) => c.args?.[k] === v)),
    );
  const kept = await keptDays(tx, tenantId);
  const nudges = outs.filter((o) => has(o.toolCalls, NUDGE_MARK));
  const a = schema.auditLog;
  const audits = await tx
    .select({ action: a.action, after: a.after })
    .from(a)
    .where(
      and(
        eq(a.tenantId, tenantId),
        gt(a.createdAt, since),
        sql`${a.action} in ('nudge_opt_in', 'nudge_auto_pause')`,
      ),
    );
  const p = schema.phoneNumber;
  const owners = await tx
    .select({
      optIn: p.nudgeOptInAt,
      off: p.nudgeOffAt,
      all: p.unsolicitedOffAt,
      until: p.nudgePausedUntil,
    })
    .from(p)
    .where(and(eq(p.tenantId, tenantId), eq(p.role, "owner"), eq(p.status, "active")));
  const on = owners.filter((o) => o.optIn && !o.off && !o.all);
  const optIns = audits.filter((x) => x.action === "nudge_opt_in");
  return {
    offers: outs.filter((o) => has(o.toolCalls, "habit_optin_offer")).length,
    optInsButton: optIns.filter((x) => (x.after as { text_id?: string } | null)?.text_id === "H7")
      .length,
    optInsOther: optIns.filter((x) => (x.after as { text_id?: string } | null)?.text_id !== "H7")
      .length,
    optedIn: on.length,
    paused: on.filter((o) => o.until && o.until.getTime() > now.getTime()).length,
    sent: nudges.filter((o) => o.status === "ok").length,
    failed: nudges.filter((o) => o.status === "failed").length,
    answered: nudges.filter((o) => o.status === "ok" && kept.has(businessDateOf(o.at))).length,
    noSpendButton: outs.filter((o) => has(o.toolCalls, "habit_no_spend", { via: "button" })).length,
    autoPauses: audits.filter((x) => x.action === "nudge_auto_pause").length,
  };
}

export function sumNudgeStats(list: NudgeStats[]): NudgeStats {
  const out: NudgeStats = {
    offers: 0,
    optInsButton: 0,
    optInsOther: 0,
    optedIn: 0,
    paused: 0,
    sent: 0,
    failed: 0,
    answered: 0,
    noSpendButton: 0,
    autoPauses: 0,
  };
  for (const s of list) for (const k of Object.keys(out) as (keyof NudgeStats)[]) out[k] += s[k];
  return out;
}
