import { and, eq, type Queryable, rows, schema, sql, type Tx } from "@caja/db";
import { addDays, businessDateOf, type IsoDate } from "../domain/dates";

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
export type HabitSettings = { streakLine: boolean; noSpend: boolean };

export const HABIT_DEFAULTS: HabitSettings = { streakLine: false, noSpend: false };
const KEY = "habits";

export async function habitSettings(db: Queryable): Promise<HabitSettings> {
  const [r] = await db
    .select({ value: schema.appSetting.value })
    .from(schema.appSetting)
    .where(eq(schema.appSetting.key, KEY));
  const v = (r?.value ?? {}) as Record<string, unknown>;
  return {
    streakLine: v.streakLine === true,
    noSpend: v.noSpend === true,
  };
}

export async function saveHabitSettings(
  db: Queryable,
  next: HabitSettings,
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

/**
 * Números de un negocio para /admin "Hábito" y `pnpm metrics` (plan de medición §5, filas 1–4).
 * Solo conteos: ni nombres ni textos. Los dos lados usan esta función, así que dicen lo mismo.
 */
export type HabitStats = {
  current: number;
  /** Escribió en los últimos 7 días. */
  active7: boolean;
  /** Días con registro (no cuenta "sin gastos") en los últimos 28, y días posibles desde que se registró. */
  recordDays28: number;
  eligibleDays28: number;
  /** Días sin gastos marcados en los últimos 7. */
  noSpendDays7: number;
  /** De los últimos 7 días cumplidos: con el dueño en la ventana de 24 h a las 8 pm, y de esos, sin registro antes de las 8 pm. */
  windowOpen7: number;
  windowOpenNoRecord7: number;
  ownerDays7: number;
  /** Retención: registró en la semana 2 (días 7–13) y en la semana 5 (días 28–34); null si todavía no llega. */
  d7: boolean | null;
  d30: boolean | null;
};

export async function habitStats(
  tx: Tx,
  tenant: { id: string; createdAt: Date },
  now: Date,
): Promise<HabitStats> {
  const today = businessDateOf(now);
  const signup = businessDateOf(tenant.createdAt);
  const kept = await keptDays(tx, tenant.id);
  const streak = await streakFor(tx, tenant.id, now);
  const recorded = (d: IsoDate) => kept.get(d) === "recorded";
  const daysBetween = (a: IsoDate, b: IsoDate) =>
    Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
  let recordDays28 = 0;
  let eligibleDays28 = 0;
  for (let i = 0; i < 28; i++) {
    const d = addDays(today, -i);
    if (d < signup) break;
    eligibleDays28 += 1;
    if (recorded(d)) recordDays28 += 1;
  }
  let noSpendDays7 = 0;
  for (let i = 0; i < 7; i++) if (kept.get(addDays(today, -i)) === "no_spend") noSpendDays7 += 1;
  const week = (from: number, to: number) => {
    if (daysBetween(signup, today) < to) return null;
    for (let i = from; i <= to; i++) if (recorded(addDays(signup, i))) return true;
    return false;
  };
  const [w] = rows<{ open: number; open_no_record: number; days: number; active: boolean }>(
    await tx.execute(sql`
      with owner as (
        select id from app.phone_number
        where tenant_id = ${tenant.id} and role = 'owner' and status = 'active'
      ),
      days as (
        select d::date as d,
               ((d::date)::timestamp + interval '20 hours') at time zone 'America/Caracas' as at8
        from generate_series(${today}::date - 7, ${today}::date - 1, interval '1 day') d
        where d::date >= ${signup}::date
      ),
      firsts as (
        select (created_at at time zone 'America/Caracas')::date as d, min(created_at) as first_at
        from app.movement where tenant_id = ${tenant.id} and deleted_at is null
        group by 1
      )
      select
        count(*) filter (where open)::int as open,
        count(*) filter (where open and (f.first_at is null or f.first_at > days.at8))::int
          as open_no_record,
        count(*)::int as days,
        exists (
          select 1 from app.message
          where tenant_id = ${tenant.id} and direction = 'in'
            and created_at > ${now.toISOString()}::timestamptz - interval '7 days'
        ) as active
      from days
      left join firsts f on f.d = days.d
      cross join lateral (
        select exists (
          select 1 from app.message m join owner o on o.id = m.phone_id
          where m.direction = 'in'
            and m.created_at > days.at8 - interval '23 hours 30 minutes'
            and m.created_at <= days.at8
        ) as open
      ) w
    `),
  );
  return {
    current: streak.current,
    active7: !!w?.active,
    recordDays28,
    eligibleDays28,
    noSpendDays7,
    windowOpen7: w?.open ?? 0,
    windowOpenNoRecord7: w?.open_no_record ?? 0,
    ownerDays7: w?.days ?? 0,
    d7: week(7, 13),
    d30: week(28, 34),
  };
}
