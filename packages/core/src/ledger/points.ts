import {
  and,
  asc,
  type Db,
  desc,
  eq,
  everyTenantId,
  isNull,
  rows,
  schema,
  sql,
  type Tx,
  withTenant,
} from "@caja/db";
import {
  addNotice,
  type GiftLine,
  LEVEL_MIN,
  type Level,
  levelForTotal,
  levelKind,
  MAX_LEVEL,
  ONE_TIME_RULES,
  overCeilingTwoMonths,
  POINT_RULES,
  type RewardSettings,
  releaseCeilingGrants,
  releaseHeldGrants,
  rewardSettings,
  STREAK_BONUS,
  saveRewardSettings,
  settleGrant,
  waitingGrants,
} from "../billing/rewards";
import { caracasMonth } from "../billing/usage";
import { addDays, businessDateOf, type IsoDate } from "../domain/dates";
import { type Logger, silentLogger } from "../log";
import { type HabitSettings, habitSettings, keptDays, type StreakDayState } from "./habits";

/**
 * Puntos (PRD hábitos v4.2.1, fase 4, US-414/US-415). Un libro, `points_event`: una fila por regla
 * y clave (`(tenant_id, rule, ref_key)` único), así que sincronizar dos veces nunca suma dos veces.
 * Corre dentro de la transacción del negocio (RLS) y solo con `habits.xp` encendido. Ninguna
 * herramienta del agente llega aquí (SEC-P4-14): solo rutas fijas, el 8 pm y el mantenimiento.
 */

export type PointsState = {
  total: number;
  /** Puntos de hoy (Caracas): lo hecho hoy, sin la configuración de días anteriores. */
  today: number;
  level: Level;
  /** Subió de nivel en esta sincronización: el más alto, con su línea (RW2). */
  levelUp: { level: Level; line: GiftLine } | null;
  /** Bono de racha de hoy, si lo hubo (RW3-B). */
  bonusToday: { points: number; n: number } | null;
  /** Solo tiene puntos de la configuración (RW4 «new owner», RW5-7). */
  onlySetup: boolean;
};

type Ctx = { flags: HabitSettings; settings: RewardSettings };

const REV = ":rev";

/** Corridas de días seguidos (con registro o sin gastos), en orden. */
function runsOf(kept: Map<string, StreakDayState>): { start: IsoDate; days: IsoDate[] }[] {
  const days = [...kept.keys()].sort() as IsoDate[];
  const out: { start: IsoDate; days: IsoDate[] }[] = [];
  for (const d of days) {
    const last = out[out.length - 1];
    const prev = last?.days[last.days.length - 1];
    if (last && prev && addDays(prev, 1) === d) last.days.push(d);
    else out.push({ start: d, days: [d] });
  }
  return out;
}

/**
 * Bonos de racha válidos hoy (§P4.3): en el día n de una corrida con ((n − 1) mod 30) + 1 en 7, 15
 * o 30, si al menos la mitad de esos últimos 7, 15 o 30 días tienen registro (A16).
 */
function streakBonuses(
  kept: Map<string, StreakDayState>,
): Map<string, { date: IsoDate; points: number; n: number }> {
  const valid = new Map<string, { date: IsoDate; points: number; n: number }>();
  for (const run of runsOf(kept)) {
    run.days.forEach((date, i) => {
      const n = i + 1;
      const m = ((n - 1) % 30) + 1;
      const points = STREAK_BONUS[m];
      if (!points) return;
      const window = run.days.slice(n - m, n);
      const recorded = window.filter((d) => kept.get(d) === "recorded").length;
      if (recorded >= Math.ceil(m / 2)) valid.set(`${run.start}:${n}`, { date, points, n });
    });
  }
  return valid;
}

/** Fechas (Caracas) en que se cumplió cada regla de una sola vez, si ya se cumplió. */
async function oneTimeDates(tx: Tx, tenantId: string): Promise<Record<string, string | null>> {
  const day = (col: string) => sql.raw(`(${col} at time zone 'America/Caracas')::date::text`);
  const [r] = rows<Record<string, string | null>>(
    await tx.execute(sql`
      select
        (select ${day("created_at")} from app.tenant where id = ${tenantId}) as signup_done,
        (select min(${day("created_at")}) from app.tenant_member where tenant_id = ${tenantId})
          as panel_connected,
        (select ${day("created_at")} from app.account
          where tenant_id = ${tenantId} and archived_at is null
          order by created_at offset 1 limit 1) as accounts_2,
        (select min(${day("created_at")}) from app.budget where tenant_id = ${tenantId})
          as first_budget,
        (select min(${day("created_at")}) from app.reminder where tenant_id = ${tenantId})
          as first_reminder,
        (select min(${day("coalesce(verified_at, created_at)")}) from app.phone_number
          where tenant_id = ${tenantId} and role = 'employee' and status = 'active')
          as employee_joined
    `),
  );
  return r ?? {};
}

async function award(
  tx: Tx,
  tenantId: string,
  e: { rule: string; refKey: string; points: number; date: string; reason?: string | null },
  now: Date,
  reverses?: string,
): Promise<boolean> {
  const done = await tx
    .insert(schema.pointsEvent)
    .values({
      tenantId,
      rule: e.rule,
      refKey: e.refKey,
      points: e.points,
      businessDate: e.date,
      reason: e.reason ?? null,
      reverses: reverses ?? null,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.pointsEvent.id });
  return done.length > 0;
}

/** Suma del libro (nunca menos de 0) y lo de hoy. */
export async function pointsTotals(
  tx: Tx,
  tenantId: string,
  now: Date,
): Promise<{ total: number; today: number; dailyEver: boolean }> {
  const today = businessDateOf(now);
  const [r] = rows<{ total: string | null; today: string | null; daily: boolean | null }>(
    await tx.execute(sql`
      select coalesce(sum(points), 0)::text as total,
             coalesce(sum(points) filter (where business_date = ${today}::date
                                            and points > 0), 0)::text as today,
             bool_or(rule in ('record_day', 'close_day', 'streak_bonus') and points > 0) as daily
      from app.points_event where tenant_id = ${tenantId}
    `),
  );
  return {
    total: Math.max(0, Number(r?.total ?? 0)),
    today: Math.max(0, Number(r?.today ?? 0)),
    dailyEver: r?.daily === true,
  };
}

/**
 * Pone el libro al día (US-414): reglas de una vez (A40: lo que ya existe), un +5 por día con
 * registro desde `xpOnSince`, los bonos de racha, y las reversas de días ya cerrados que perdieron
 * sus registros (§P4.4 regla 3). Luego el nivel (US-415) y sus regalos (US-416). Devuelve null con
 * `xp` apagado.
 */
export async function syncPoints(
  tx: Tx,
  tenantId: string,
  now: Date,
  ctx?: Partial<Ctx>,
): Promise<PointsState | null> {
  const flags = ctx?.flags ?? (await habitSettings(tx));
  if (!flags.xp) return null;
  const settings = ctx?.settings ?? (await rewardSettings(tx));
  const today = businessDateOf(now);
  const since = settings.xpOnSince ?? today;

  // Una sola vez: lo que ya existe en el negocio, con la fecha en que pasó.
  const once = await oneTimeDates(tx, tenantId);
  for (const rule of ONE_TIME_RULES) {
    const date = once[rule];
    if (date)
      await award(tx, tenantId, { rule, refKey: rule, points: POINT_RULES[rule], date }, now);
  }

  // Cada día: +5 por día con registro (no "hoy no gasté nada"), desde que se encendió.
  const kept = await keptDays(tx, tenantId);
  for (const [date, state] of kept) {
    if (state !== "recorded" || date < since || date > today) continue;
    await award(
      tx,
      tenantId,
      { rule: "record_day", refKey: date, points: POINT_RULES.record_day, date },
      now,
    );
  }
  const bonuses = streakBonuses(kept);
  for (const [key, b] of bonuses) {
    if (b.date < since || b.date > today) continue;
    await award(
      tx,
      tenantId,
      { rule: "streak_bonus", refKey: key, points: b.points, date: b.date },
      now,
    );
  }

  // Reversas: un día ya cerrado (antes de hoy) que dejó de tener registro, o un bono cuya racha
  // ya no existe. Una por premio (`ref_key` + ":rev"); el total nunca baja de 0.
  const awarded = await tx
    .select()
    .from(schema.pointsEvent)
    .where(
      and(
        eq(schema.pointsEvent.tenantId, tenantId),
        sql`${schema.pointsEvent.rule} in ('record_day', 'streak_bonus')`,
        sql`${schema.pointsEvent.points} > 0`,
        sql`${schema.pointsEvent.businessDate} < ${today}::date`,
      ),
    );
  const reversed = new Set(
    (
      await tx
        .select({ reverses: schema.pointsEvent.reverses })
        .from(schema.pointsEvent)
        .where(
          and(
            eq(schema.pointsEvent.tenantId, tenantId),
            sql`${schema.pointsEvent.reverses} is not null`,
          ),
        )
    ).map((r) => r.reverses),
  );
  for (const a of awarded) {
    if (reversed.has(a.id)) continue;
    const lost =
      a.rule === "record_day" ? kept.get(a.refKey) !== "recorded" : !bonuses.has(a.refKey);
    if (!lost) continue;
    await award(
      tx,
      tenantId,
      {
        rule: a.rule,
        refKey: `${a.refKey}${REV}`,
        points: -a.points,
        date: today,
        reason: "record_deleted",
      },
      now,
      a.id,
    );
  }

  return settleLevel(tx, tenantId, now, { flags, settings }, bonuses);
}

/**
 * Nivel guardado (US-415): el umbral más alto que alcanzó el total; nunca baja. Cada nivel nuevo
 * escribe su regalo (uno por negocio y nivel) y se aplica (US-416); una sola línea, la del más alto.
 */
async function settleLevel(
  tx: Tx,
  tenantId: string,
  now: Date,
  ctx: Ctx,
  bonuses?: Map<string, { date: IsoDate; points: number; n: number }>,
): Promise<PointsState> {
  const today = businessDateOf(now);
  const totals = await pointsTotals(tx, tenantId, now);
  const [t] = await tx
    .select({ level: schema.tenant.pointsLevel })
    .from(schema.tenant)
    .where(eq(schema.tenant.id, tenantId))
    .for("update");
  const stored = (t?.level ?? 1) as Level;
  const reached = levelForTotal(totals.total);
  const sctx = {
    now,
    rewardsOn: ctx.flags.rewards,
    ceilingUsd: ctx.settings.monthlyCeilingUsd,
  };
  let levelUp: PointsState["levelUp"] = null;
  if (reached > stored) {
    await tx
      .update(schema.tenant)
      .set({ pointsLevel: reached, pointsLevelAt: now })
      .where(eq(schema.tenant.id, tenantId));
    for (let l = (stored + 1) as Level; l <= reached; l = (l + 1) as Level) {
      const [g] = await tx
        .insert(schema.rewardGrant)
        .values({ tenantId, kind: levelKind(l), status: "waiting", createdAt: now, updatedAt: now })
        .onConflictDoNothing()
        .returning({ id: schema.rewardGrant.id });
      if (!g) continue;
      const r = await settleGrant(tx, g.id, sctx);
      if (r) levelUp = { level: l, line: r.line };
    }
    if (levelUp) await addNotice(tx, tenantId, "level", levelUp.line, now);
  } else {
    // Los que esperaban por `rewards` apagado o por la pausa salen cuando se puede (§P4.6).
    await releaseHeldGrants(tx, tenantId, sctx);
  }
  const bonusToday = [...(bonuses?.values() ?? [])].find((b) => b.date === today) ?? null;
  return {
    total: totals.total,
    today: totals.today,
    level: Math.max(stored, reached) as Level,
    levelUp,
    bonusToday: bonusToday ? { points: bonusToday.points, n: bonusToday.n } : null,
    onlySetup: !totals.dailyEver,
  };
}

/**
 * +2 por «Eso es todo» (§P4.3 `close_day`): solo si el botón es de hoy. Devuelve false si ya se dio
 * (un segundo toque del mismo botón, SEC-P4-14 b) o si el botón es de otro día.
 */
export async function awardCloseDay(
  tx: Tx,
  tenantId: string,
  buttonDate: string,
  now: Date,
): Promise<boolean> {
  const today = businessDateOf(now);
  if (buttonDate !== today) return false;
  return award(
    tx,
    tenantId,
    { rule: "close_day", refKey: today, points: POINT_RULES.close_day, date: today },
    now,
  );
}

// ---------------------------------------------------------------- quitar puntos a mano (US-432)

export const REMOVE_REASONS = ["fake_records", "fake_referral", "our_error"] as const;
export type RemoveReason = (typeof REMOVE_REASONS)[number];

/**
 * El fundador quita puntos (US-432): una reversa `manual` con la clave de la acción (repetirla no
 * quita dos veces), nunca más que el total; el nivel no baja y los regalos se quedan. RW8h va en la
 * próxima respuesta del dueño. Devuelve null si no hizo nada (repetida o más que el total).
 */
export async function removePoints(
  tx: Tx,
  tenantId: string,
  input: { actionId: string; points: number; reason: RemoveReason },
  now: Date,
): Promise<{ before: number; after: number } | null> {
  if (!Number.isInteger(input.points) || input.points < 1) return null;
  if (!(REMOVE_REASONS as readonly string[]).includes(input.reason)) return null;
  await tx.execute(sql`select 1 from app.tenant where id = ${tenantId} for update`);
  const { total } = await pointsTotals(tx, tenantId, now);
  if (input.points > total) return null;
  const done = await award(
    tx,
    tenantId,
    {
      rule: "manual",
      refKey: input.actionId,
      points: -input.points,
      date: businessDateOf(now),
      reason: `manual:${input.reason}`,
    },
    now,
  );
  if (!done) return null;
  await addNotice(tx, tenantId, "points_removed", { k: input.points, motivo: input.reason }, now);
  return { before: total, after: total - input.points };
}

// ---------------------------------------------------------------- líneas pendientes

export type PendingNotice = {
  id: string;
  kind: string;
  args: Record<string, unknown>;
};

/**
 * La próxima línea para el dueño (US-425): primero la de nivel más alto, después las demás por
 * orden de llegada. Una por respuesta; se marca vista solo cuando sale (`markNoticeShown`).
 */
export async function nextNotice(tx: Tx, tenantId: string): Promise<PendingNotice | null> {
  const pending = await tx
    .select()
    .from(schema.pointsNotice)
    .where(and(eq(schema.pointsNotice.tenantId, tenantId), isNull(schema.pointsNotice.shownAt)))
    .orderBy(asc(schema.pointsNotice.createdAt));
  if (pending.length === 0) return null;
  const level = (n: (typeof pending)[number]) =>
    n.kind === "level" ? Number((n.args as { level?: number }).level ?? 0) : 0;
  const best = [...pending].sort((a, b) => level(b) - level(a))[0];
  if (!best) return null;
  return { id: best.id, kind: best.kind, args: best.args as Record<string, unknown> };
}

export async function markNoticeShown(tx: Tx, id: string, now: Date): Promise<void> {
  await tx
    .update(schema.pointsNotice)
    .set({ shownAt: now })
    .where(and(eq(schema.pointsNotice.id, id), isNull(schema.pointsNotice.shownAt)));
}

// ---------------------------------------------------------------- lo que ve el dueño (RW4, /logros)

export type GrantView = {
  level: Level;
  status: string;
  waitReason: string | null;
  appliedAs: string | null;
  appliedAt: Date | null;
};

export type PointsView = {
  total: number;
  today: number;
  level: Level;
  next: Level | null;
  /** Puntos que faltan para el siguiente nivel. */
  missing: number;
  onlySetup: boolean;
  grants: GrantView[];
  /** Reversas para «Mis logros» (N-2): cuántos puntos, por qué y cuándo. */
  reversals: { points: number; reason: string; date: string }[];
  /** Hechas las reglas de una vez (chip `Hecho`, RW1c). */
  done: string[];
};

export async function pointsView(tx: Tx, tenantId: string, now: Date): Promise<PointsView> {
  const totals = await pointsTotals(tx, tenantId, now);
  const [t] = await tx
    .select({ level: schema.tenant.pointsLevel })
    .from(schema.tenant)
    .where(eq(schema.tenant.id, tenantId));
  const level = Math.max((t?.level ?? 1) as Level, levelForTotal(totals.total)) as Level;
  const next = level < MAX_LEVEL ? ((level + 1) as Level) : null;
  const grants = await tx
    .select()
    .from(schema.rewardGrant)
    .where(and(eq(schema.rewardGrant.tenantId, tenantId), sql`kind like 'level_%'`))
    .orderBy(asc(schema.rewardGrant.kind));
  const events = await tx
    .select()
    .from(schema.pointsEvent)
    .where(eq(schema.pointsEvent.tenantId, tenantId))
    .orderBy(desc(schema.pointsEvent.createdAt));
  return {
    total: totals.total,
    today: totals.today,
    level,
    next,
    missing: next ? Math.max(0, LEVEL_MIN[next] - totals.total) : 0,
    onlySetup: !totals.dailyEver,
    grants: grants.map((g) => ({
      level: Number(g.kind.slice(-1)) as Level,
      status: g.status,
      waitReason: g.waitReason,
      appliedAs: g.appliedAs,
      appliedAt: g.appliedAt,
    })),
    reversals: events
      .filter((e) => e.points < 0)
      .map((e) => ({ points: -e.points, reason: e.reason ?? "", date: e.businessDate })),
    done: events
      .filter((e) => (ONE_TIME_RULES as readonly string[]).includes(e.rule))
      .map((e) => e.rule),
  };
}

// ---------------------------------------------------------------- mantenimiento (worker)

/**
 * Cada 5 minutos, desde el housekeeping (solo con `xp`):
 * 1. La primera corrida de un mes de Caracas entrega todos los regalos detenidos por el tope, del
 *    más viejo al más nuevo entre todos los negocios, aunque pase el tope (D19); y si los dos meses
 *    anteriores cerraron por encima del tope, prende la alerta de /admin (A46).
 * 2. Una vez por día de Caracas, sincroniza cada negocio (reversas de días cerrados, bonos).
 * Cada negocio en su propia transacción con RLS; un fallo no frena a los demás. Solo conteos en logs.
 */
export async function runPointsHousekeeping(
  db: Db,
  now: Date,
  log: Logger = silentLogger,
): Promise<{ released: number; synced: number }> {
  const flags = await habitSettings(db);
  if (!flags.xp) return { released: 0, synced: 0 };
  let settings = await rewardSettings(db);
  const month = caracasMonth(now).key;
  const today = businessDateOf(now);
  const ctx = { now, rewardsOn: flags.rewards, ceilingUsd: settings.monthlyCeilingUsd };
  let released = 0;
  let synced = 0;
  // Suspendidos incluidos: Oro detenido de quien dejó de pagar pasa a esperar el pago (P-14).
  const tenants = await everyTenantId(db);
  if (settings.releasedMonth !== month) {
    const queue: { tenantId: string; id: string; at: number }[] = [];
    for (const tenantId of tenants) {
      const held = await withTenant(db, tenantId, (tx) => waitingGrants(tx, tenantId, ["ceiling"]));
      for (const g of held) queue.push({ tenantId, id: g.id, at: g.createdAt.getTime() });
    }
    queue.sort((a, b) => a.at - b.at);
    for (const q of queue) {
      try {
        released += await withTenant(db, q.tenantId, (tx) => releaseCeilingGrants(tx, [q.id], ctx));
      } catch (err) {
        log.error(
          { grantId: q.id, err: err instanceof Error ? err.message : String(err) },
          "puntos: entrega del 1",
        );
      }
    }
    const alert = await overCeilingTwoMonths(db, month, settings.monthlyCeilingUsd);
    settings = await saveRewardSettings(
      db,
      { releasedMonth: month, ...(alert ? { alertMonth: month, alertDismissed: false } : {}) },
      "system",
      now,
    );
    if (released > 0 || alert) log.info({ released, alert }, "puntos: entrega del 1");
  }
  if (settings.sweptOn !== today) {
    for (const tenantId of tenants) {
      try {
        await withTenant(db, tenantId, (tx) => syncPoints(tx, tenantId, now, { flags, settings }));
        synced += 1;
      } catch (err) {
        log.error(
          { tenantId, err: err instanceof Error ? err.message : String(err) },
          "puntos: sincronización diaria",
        );
      }
    }
    await saveRewardSettings(db, { sweptOn: today }, "system", now);
  }
  return { released, synced };
}
