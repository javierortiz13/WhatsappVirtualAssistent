import { and, eq, type Queryable, rows, schema, sql, type Tx } from "@caja/db";
import { addDays, businessDateOf, type IsoDate, weekday } from "../domain/dates";

/**
 * Hábito diario (PRD hábitos, fase 1): la racha cuenta los días seguidos que el negocio anotó algo
 * o dijo "hoy no gasté nada". Un día con registro es el día de Caracas en que se CREÓ un movimiento,
 * una transferencia o un cambio (no su fecha de negocio), y vale si al menos uno no se borró ese
 * mismo día. Igual que la consulta `rec` del plan de medición (N-1).
 */

// ---------------------------------------------------------------- interruptores (`habits`)

/**
 * Cada parte del hábito se enciende por separado desde /admin, después de su aprobación. Todo
 * apagado por defecto: sin fila, nada cambia para nadie.
 */
export const HABIT_FLAGS = [
  "streakLine",
  "noSpend",
  /** P2/P3: apagar y encender avisos (US-204, US-211). Se enciende primero y no se apaga. */
  "prefs",
  /** P3: recordatorios de plata (US-301…US-309). */
  "reminders",
  /** P2: el aviso de las 8 pm (US-207). Solo si la lectura del 13/11 lo justifica. */
  "nudge",
  /** P3 camino d: la plantilla de Meta (US-310). Espera la aprobación de Meta. */
  "reminderTemplate",
] as const;
export type HabitFlag = (typeof HABIT_FLAGS)[number];
export type HabitSettings = Record<HabitFlag, boolean>;

export const HABIT_DEFAULTS: HabitSettings = {
  streakLine: false,
  noSpend: false,
  prefs: false,
  reminders: false,
  nudge: false,
  reminderTemplate: false,
};
const KEY = "habits";

export async function habitSettings(db: Queryable): Promise<HabitSettings> {
  const [r] = await db
    .select({ value: schema.appSetting.value })
    .from(schema.appSetting)
    .where(eq(schema.appSetting.key, KEY));
  const v = (r?.value ?? {}) as Record<string, unknown>;
  return Object.fromEntries(HABIT_FLAGS.map((f) => [f, v[f] === true])) as HabitSettings;
}

export async function saveHabitSettings(
  db: Queryable,
  next: Partial<HabitSettings>,
  actor: string,
  now: Date,
): Promise<void> {
  // Se guardan junto a lo que ya hubiera (las fases siguientes agregan sus interruptores).
  const [r] = await db
    .select({ value: schema.appSetting.value })
    .from(schema.appSetting)
    .where(eq(schema.appSetting.key, KEY));
  const value = { ...((r?.value ?? {}) as Record<string, unknown>), ...next };
  await db
    .insert(schema.appSetting)
    .values({ key: KEY, value, updatedAt: now, updatedBy: actor })
    .onConflictDoUpdate({
      target: schema.appSetting.key,
      set: { value, updatedAt: now, updatedBy: actor },
    });
}

// ---------------------------------------------------------------- racha

export type StreakDayState = "recorded" | "no_spend" | "none";

export type Streak = {
  /** Días seguidos que terminan hoy o ayer (hoy, si todavía no cuenta, no corta la racha). */
  current: number;
  /** La racha más larga de todas, incluida la de hoy. */
  best: number;
  /** La más larga antes de la racha actual (para "¡Nuevo récord!", H3). */
  bestBefore: number;
  /** La racha justo anterior a la actual (para "arrancamos una racha nueva", H4). */
  previous: number;
  recordedToday: boolean;
  noSpendToday: boolean;
  keptToday: boolean;
  /** Alguna vez anotó algo o marcó un día sin gastos. */
  everKept: boolean;
  /** Los últimos 7 días, del más viejo a hoy. */
  last7: { date: IsoDate; state: StreakDayState }[];
};

/** Días con registro o sin gastos del negocio, de Caracas. */
async function keptDays(tx: Tx, tenantId: string): Promise<Map<string, StreakDayState>> {
  const found = rows<{ d: string; recorded: boolean }>(
    await tx.execute(sql`
      with rec as (
        select created_at, deleted_at from app.movement where tenant_id = ${tenantId}
        union all
        select created_at, deleted_at from app.account_transfer where tenant_id = ${tenantId}
        union all
        select created_at, deleted_at from app.exchange_lot
        where tenant_id = ${tenantId} and source = 'exchange'
      )
      select d, bool_or(recorded) as recorded from (
        select (created_at at time zone 'America/Caracas')::date::text as d, true as recorded
        from rec
        where deleted_at is null
           or (deleted_at at time zone 'America/Caracas')::date
              <> (created_at at time zone 'America/Caracas')::date
        union all
        select day::text as d, false as recorded from app.no_spend_day where tenant_id = ${tenantId}
      ) x
      group by d
    `),
  );
  return new Map(found.map((r) => [r.d, r.recorded ? "recorded" : "no_spend"] as const));
}

/** La racha del negocio a hoy (US-101). Todo lo demás (tarjeta, Inicio, métricas) sale de aquí. */
export async function streakFor(tx: Tx, tenantId: string, now: Date): Promise<Streak> {
  const kept = await keptDays(tx, tenantId);
  const today = businessDateOf(now);
  const yesterday = addDays(today, -1);
  const isKept = (d: IsoDate) => kept.has(d);
  /** Largo de la racha que termina en `d` (0 si ese día no cuenta). */
  const runEnding = (d: IsoDate) => {
    let n = 0;
    let cur = d;
    while (isKept(cur)) {
      n += 1;
      cur = addDays(cur, -1);
    }
    return n;
  };
  const end = isKept(today) ? today : yesterday;
  const current = runEnding(end);
  // La más larga: recorre los días en orden y cuenta corridas.
  const days = [...kept.keys()].sort();
  let best = 0;
  let bestBefore = 0;
  let previous = 0;
  let run = 0;
  let prev: string | null = null;
  const currentStart = current ? addDays(end, -(current - 1)) : null;
  for (const d of days) {
    run = prev && addDays(prev as IsoDate, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    // Las corridas que terminaron antes de que empezara la actual.
    if (!currentStart || d < currentStart) {
      bestBefore = Math.max(bestBefore, run);
      previous = run;
    }
    prev = d;
  }
  const state = (d: IsoDate): StreakDayState => kept.get(d) ?? "none";
  return {
    current,
    best,
    bestBefore,
    previous,
    recordedToday: kept.get(today) === "recorded",
    noSpendToday: kept.get(today) === "no_spend",
    keptToday: isKept(today),
    everKept: kept.size > 0,
    last7: Array.from({ length: 7 }, (_, i) => {
      const date = addDays(today, i - 6);
      return { date, state: state(date) };
    }),
  };
}

// ---------------------------------------------------------------- "hoy no gasté nada"

/** Frases exactas (normalizadas) de un día sin gastos (US-106). Todo el mensaje, nada más. */
const NO_SPEND_PHRASES = new Set([
  "hoy no gaste nada",
  "hoy no gaste",
  "no gaste nada hoy",
  "hoy no hubo gastos",
  "hoy sin gastos",
  "sin gastos hoy",
  "hoy no hubo movimiento",
  "hoy no hubo movimientos",
  "hoy no hubo nada que anotar",
  "hoy no hubo ventas ni gastos",
  "hoy no abrimos",
  "hoy no abri",
]);

/** ¿El mensaje entero dice que hoy no hubo gastos? Con otra cosa más, va al flujo normal. */
export function isNoSpendPhrase(text: string): boolean {
  const t = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return NO_SPEND_PHRASES.has(t);
}

export type NoSpendResult =
  /** Se anotó el día; `n` es la racha después de anotarlo. */
  | { kind: "marked"; streak: Streak }
  /** Hoy ya hay registros: el día ya cuenta, no se anota nada. */
  | { kind: "already_recorded" }
  /** Ya estaba anotado hoy. */
  | { kind: "already_marked"; streak: Streak };

/** Anota hoy como día sin gastos, si hace falta (US-106). Una vez al día, sin XP. */
export async function markNoSpend(
  tx: Tx,
  input: { tenantId: string; phoneId: string; now: Date },
): Promise<NoSpendResult> {
  const before = await streakFor(tx, input.tenantId, input.now);
  if (before.recordedToday) return { kind: "already_recorded" };
  if (before.noSpendToday) return { kind: "already_marked", streak: before };
  await tx
    .insert(schema.noSpendDay)
    .values({
      tenantId: input.tenantId,
      phoneId: input.phoneId,
      day: businessDateOf(input.now),
    })
    .onConflictDoNothing();
  return { kind: "marked", streak: await streakFor(tx, input.tenantId, input.now) };
}

/** ¿Este teléfono ya vio hoy la línea de racha (en una tarjeta o en la respuesta sin gastos)? */
export async function streakShownToday(tx: Tx, phoneId: string, now: Date): Promise<boolean> {
  const start = sql`((${businessDateOf(now)}::date)::timestamp at time zone 'America/Caracas')`;
  const [hit] = await tx
    .select({ id: schema.message.id })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.phoneId, phoneId),
        eq(schema.message.direction, "out"),
        sql`${schema.message.createdAt} >= ${start}`,
        sql`(${schema.message.toolCalls} @> '[{"name": "habit_streak_line"}]'::jsonb
             or ${schema.message.toolCalls} @> '[{"name": "habit_no_spend"}]'::jsonb)`,
      ),
    )
    .limit(1);
  return !!hit;
}

/** ¿Alguna vez este negocio vio la línea de racha? (H1a la primera vez.) */
export async function streakLineEverShown(tx: Tx, tenantId: string): Promise<boolean> {
  const [hit] = await tx
    .select({ id: schema.message.id })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.tenantId, tenantId),
        eq(schema.message.direction, "out"),
        sql`${schema.message.toolCalls} @> '[{"name": "habit_streak_line"}]'::jsonb`,
      ),
    )
    .limit(1);
  return !!hit;
}

// ---------------------------------------------------------------- números del hábito (US-104, US-107)

/** Lo que `habitStats` necesita del negocio. */
export type HabitTenant = {
  id: string;
  createdAt: Date;
  /** En la papelera desde (0017). */
  deletedAt?: Date | null;
  /** Suspensión actual (solo la última; el plan lo acepta a esta escala). */
  suspendedAt?: Date | null;
  status?: string;
};

/**
 * Números de un negocio para /admin "Hábito" y `pnpm metrics` (plan de medición §1.2 M1–M3 y §5
 * filas 1–4, alineado en ER-4). Solo conteos: ni nombres ni textos. Los dos lados suman con
 * `summarizeHabits`, así que dicen lo mismo, y lo mismo que la SQL del plan.
 */
export type HabitStats = {
  current: number;
  /** Escribió en los últimos 7 días (M1). */
  active7: boolean;
  /** Escribió en la ventana de 28 días que termina ayer (M2). */
  active28: boolean;
  /**
   * M2: días con registro (no cuenta "sin gastos") y días posibles en los 28 que terminan ayer:
   * desde el registro, antes de la papelera y antes de la suspensión. Ambos 0 si no escribió en la
   * ventana.
   */
  recordDays28: number;
  eligibleDays28: number;
  /** Días sin gastos marcados en los últimos 7. */
  noSpendDays7: number;
  /** B4, últimos 7 días cumplidos, por teléfono dueño: con la ventana de 24 h abierta a las 8 pm, y de esos sin ningún registro todavía. */
  windowOpen7: number;
  windowOpenNoRecord7: number;
  ownerDays7: number;
  /** M3: lunes de la semana (Caracas) en que se registró. */
  cohortWeek: IsoDate;
  /** Registró (o escribió) en los días 7–13 y 28–34; null si esa semana no ha terminado. */
  d7: boolean | null;
  d7Wrote: boolean | null;
  d30: boolean | null;
  d30Wrote: boolean | null;
  /** En la papelera: fuera de M1 y de la ventana de las 8 pm; sigue en su cohorte (M3). */
  trashed: boolean;
  /** `status = 'active'` (pagó), para partir D30. */
  paid: boolean;
};

export async function habitStats(tx: Tx, tenant: HabitTenant, now: Date): Promise<HabitStats> {
  const today = businessDateOf(now);
  const signup = businessDateOf(tenant.createdAt);
  const trashDay = tenant.deletedAt ? businessDateOf(tenant.deletedAt) : null;
  const suspendDay = tenant.suspendedAt ? businessDateOf(tenant.suspendedAt) : null;
  const kept = await keptDays(tx, tenant.id);
  const streak = await streakFor(tx, tenant.id, now);
  const recorded = (d: IsoDate) => kept.get(d) === "recorded";

  const [w] = rows<{
    open: number;
    open_no_record: number;
    days: number;
    active7: boolean;
    active28: boolean;
    wrote: string[] | null;
  }>(
    await tx.execute(sql`
      with owner as (
        select id from app.phone_number
        where tenant_id = ${tenant.id} and role = 'owner' and status = 'active'
      ),
      days as (
        select d::date as d,
               ((d::date)::timestamp + interval '20 hours') at time zone 'America/Caracas' as at8
        from generate_series(${today}::date - 7, ${today}::date - 1, interval '1 day') d
      ),
      rec as (
        select created_at from (
          select created_at, deleted_at from app.movement where tenant_id = ${tenant.id}
          union all
          select created_at, deleted_at from app.account_transfer where tenant_id = ${tenant.id}
          union all
          select created_at, deleted_at from app.exchange_lot
          where tenant_id = ${tenant.id} and source = 'exchange'
        ) r
        where deleted_at is null
           or (deleted_at at time zone 'America/Caracas')::date
              > (created_at at time zone 'America/Caracas')::date
      ),
      slots as (
        select
          exists (
            select 1 from app.message m
            where m.phone_id = o.id and m.direction = 'in'
              and m.created_at > days.at8 - interval '23 hours 30 minutes'
              and m.created_at <= days.at8
          ) as open,
          exists (
            select 1 from rec x
            where (x.created_at at time zone 'America/Caracas')::date = days.d
              and x.created_at <= days.at8
          ) as before20
        from days cross join owner o
      )
      select
        (select count(*) filter (where open) from slots)::int as open,
        (select count(*) filter (where open and not before20) from slots)::int as open_no_record,
        (select count(*) from slots)::int as days,
        exists (
          select 1 from app.message
          where tenant_id = ${tenant.id} and direction = 'in'
            and created_at >= ${now.toISOString()}::timestamptz - interval '7 days'
        ) as active7,
        exists (
          select 1 from app.message
          where tenant_id = ${tenant.id} and direction = 'in'
            and (created_at at time zone 'America/Caracas')::date
                between ${today}::date - 28 and ${today}::date - 1
        ) as active28,
        (
          select array_agg(distinct (created_at at time zone 'America/Caracas')::date::text)
          from app.message
          where tenant_id = ${tenant.id} and direction = 'in' and kind <> 'reaction'
            and (created_at at time zone 'America/Caracas')::date
                between ${signup}::date + 7 and ${signup}::date + 34
        ) as wrote
    `),
  );

  // M2: los 28 días que terminan ayer, desde el registro, antes de la papelera y de la suspensión.
  let recordDays28 = 0;
  let eligibleDays28 = 0;
  if (w?.active28)
    for (let i = 1; i <= 28; i++) {
      const d = addDays(today, -i);
      if (d < signup) break;
      if ((trashDay && d >= trashDay) || (suspendDay && d >= suspendDay)) continue;
      eligibleDays28 += 1;
      if (recorded(d)) recordDays28 += 1;
    }
  let noSpendDays7 = 0;
  for (let i = 0; i < 7; i++) if (kept.get(addDays(today, -i)) === "no_spend") noSpendDays7 += 1;

  // M3: la semana cuenta cuando ya terminó (su último día es antes de hoy).
  const wrote = new Set(w?.wrote ?? []);
  const week = (from: number, to: number, hit: (d: IsoDate) => boolean) => {
    if (!(addDays(signup, to) < today)) return null;
    for (let i = from; i <= to; i++) if (hit(addDays(signup, i))) return true;
    return false;
  };
  const wroteOn = (d: IsoDate) => wrote.has(d);
  return {
    current: streak.current,
    active7: !!w?.active7,
    active28: !!w?.active28,
    recordDays28,
    eligibleDays28,
    noSpendDays7,
    windowOpen7: w?.open ?? 0,
    windowOpenNoRecord7: w?.open_no_record ?? 0,
    ownerDays7: w?.days ?? 0,
    cohortWeek: addDays(signup, -((weekday(signup) + 6) % 7)),
    d7: week(7, 13, recorded),
    d7Wrote: week(7, 13, wroteOn),
    d30: week(28, 34, recorded),
    d30Wrote: week(28, 34, wroteOn),
    trashed: !!tenant.deletedAt,
    paid: tenant.status === "active",
  };
}

export type HabitCohort = {
  week: IsoDate;
  signedUp: number;
  d7Mature: number;
  d7Recorded: number;
  d7Wrote: number;
  d30Mature: number;
  d30Recorded: number;
  d30RecordedPaid: number;
  d30Wrote: number;
};

/** Tarjeta "Hábito" de /admin y `pnpm metrics`, filas 1–4 del plan (§5). */
export type HabitSummary = {
  /** M1: activos 7 d (sin papelera) y sus rachas. */
  active: number;
  streak7: number;
  streak2to6: number;
  streak30: number;
  /** M2: agrupado y mediana por usuario (percentil 50 interpolado, como la SQL del plan). */
  users: number;
  recordDays: number;
  eligibleDays: number;
  medianPct: number | null;
  noSpendDays7: number;
  /** Fila 3 (B4, 7 d), sin papelera. */
  windowOpen: number;
  windowOpenNoRecord: number;
  ownerDays: number;
  /** M3 por semana de registro, de la más nueva a la más vieja (papelera incluida). */
  cohorts: HabitCohort[];
};

export function summarizeHabits(stats: HabitStats[]): HabitSummary {
  const live = stats.filter((s) => !s.trashed);
  const active = live.filter((s) => s.active7);
  const m2 = stats.filter((s) => s.eligibleDays28 > 0);
  const shares = m2.map((s) => s.recordDays28 / s.eligibleDays28).sort((a, b) => a - b);
  const median = (() => {
    if (!shares.length) return null;
    const pos = (shares.length - 1) / 2;
    const lo = shares[Math.floor(pos)] ?? 0;
    const hi = shares[Math.ceil(pos)] ?? lo;
    return lo + (hi - lo) * (pos - Math.floor(pos));
  })();
  const sum = (list: HabitStats[], f: (s: HabitStats) => number) =>
    list.reduce((n, s) => n + f(s), 0);
  const weeks = new Map<IsoDate, HabitCohort>();
  for (const s of stats) {
    const c = weeks.get(s.cohortWeek) ?? {
      week: s.cohortWeek,
      signedUp: 0,
      d7Mature: 0,
      d7Recorded: 0,
      d7Wrote: 0,
      d30Mature: 0,
      d30Recorded: 0,
      d30RecordedPaid: 0,
      d30Wrote: 0,
    };
    c.signedUp += 1;
    if (s.d7 !== null) c.d7Mature += 1;
    if (s.d7) c.d7Recorded += 1;
    if (s.d7Wrote) c.d7Wrote += 1;
    if (s.d30 !== null) c.d30Mature += 1;
    if (s.d30) c.d30Recorded += 1;
    if (s.d30 && s.paid) c.d30RecordedPaid += 1;
    if (s.d30Wrote) c.d30Wrote += 1;
    weeks.set(s.cohortWeek, c);
  }
  return {
    active: active.length,
    streak7: active.filter((s) => s.current >= 7).length,
    streak2to6: active.filter((s) => s.current >= 2 && s.current <= 6).length,
    streak30: active.filter((s) => s.current >= 30).length,
    users: m2.length,
    recordDays: sum(m2, (s) => s.recordDays28),
    eligibleDays: sum(m2, (s) => s.eligibleDays28),
    medianPct: median === null ? null : Math.round(median * 1000) / 10,
    noSpendDays7: sum(live, (s) => s.noSpendDays7),
    windowOpen: sum(live, (s) => s.windowOpen7),
    windowOpenNoRecord: sum(live, (s) => s.windowOpenNoRecord7),
    ownerDays: sum(live, (s) => s.ownerDays7),
    cohorts: [...weeks.values()].sort((a, b) => (a.week < b.week ? 1 : -1)),
  };
}
