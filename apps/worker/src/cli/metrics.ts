import {
  EMPTY_REMINDER_STATS,
  habitStats,
  isQuietHours,
  type ReminderStats,
  reminderStats,
  SIGNUP_RESCUE_AFTER_MS,
  signupCountsByDay,
  signupRescueSettings,
  sumCounts,
  summarizeHabits,
  sumReminderStats,
} from "@caja/core";
import { createDb, loadNearestEnvFile, rows, sql } from "@caja/db";

/**
 * Reporte de la semana (día 7): latencia y costo por mensaje desde `message`, envíos fallidos y
 * eventos del webhook. Lee con la URL de administrador porque cruza todos los tenants.
 * `pnpm --filter @caja/worker metrics [días]` (7 por defecto).
 */
loadNearestEnvFile();
const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_ADMIN_URL no definida");
  process.exit(2);
}
const days = Number(process.argv[2] ?? 7);
const { db, close } = createDb(url, { max: 1 });

type Row = Record<string, string | number | null>;
const q = async (label: string, query: ReturnType<typeof sql>) => {
  console.log(`\n== ${label}`);
  console.table(rows<Row>(await db.execute(query)));
};

/** Tarifa por mensaje de servicio (Meta, "Rest of Latin America", desde el 1/10/2026). Ajustable: META_MSG_RATE_USD. */
const rate = Number(process.env.META_MSG_RATE_USD ?? "0.0113");
const FREE_TIER = 1000;

(async () => {
  await q(
    "Cupo de Meta este mes: mensajes de servicio del número de la plataforma (1.000 gratis por número)",
    sql`
      with m as (
        select direction, kind, status
        from app.message
        where created_at >= (date_trunc('month', now() at time zone 'America/Caracas') at time zone 'America/Caracas')
      ),
      d as (
        select extract(day from (now() at time zone 'America/Caracas'))::int as dia_hoy,
               extract(day from (date_trunc('month', now() at time zone 'America/Caracas') + interval '1 month - 1 day'))::int as dias_mes
      ),
      -- Los mensajes del registro por WhatsApp no van a \`message\` (P-19): contador diario desde
      -- el despliegue de signup-reminders (app_setting signup_counts:<fecha>).
      r as (
        select coalesce(sum((value->>'sends')::int), 0) as registro
        from app.app_setting
        where key like 'signup_counts:%'
          and key >= 'signup_counts:' || to_char(date_trunc('month', now() at time zone 'America/Caracas'), 'YYYY-MM-DD')
      ),
      c as (
        select count(*) filter (where direction = 'out' and kind <> 'reaction' and status in ('ok', 'sending')) + (select registro from r) as enviados,
               (select registro from r) as de_registro,
               count(*) filter (where direction = 'out' and kind = 'reaction' and status in ('ok', 'sending')) as reacciones,
               count(*) filter (where direction = 'in') as entrantes
        from m
      )
      select c.enviados, c.de_registro, c.reacciones, c.entrantes,
             greatest(c.enviados - ${FREE_TIER}, 0) as sobre_cupo,
             round(greatest(c.enviados - ${FREE_TIER}, 0) * ${rate}::numeric, 2) as costo_usd_estimado,
             round(c.enviados::numeric / nullif(c.entrantes, 0), 2) as salientes_por_entrante,
             round(c.enviados::numeric / d.dia_hoy * d.dias_mes) as proyeccion_mes
      from c, d`,
  );
  await q(
    "Mensajes salientes del mes por negocio (para repartir el costo de Meta)",
    sql`
      select t.name as negocio,
             count(*) filter (where m.direction = 'out' and m.kind <> 'reaction') as salientes,
             count(*) filter (where m.direction = 'in') as entrantes,
             round(count(*) filter (where m.direction = 'out' and m.kind <> 'reaction') * ${rate}::numeric, 2) as costo_usd_si_sin_cupo
      from app.message m join app.tenant t on t.id = m.tenant_id
      where m.created_at >= date_trunc('month', now() at time zone 'America/Caracas') at time zone 'America/Caracas'
      group by 1 order by 2 desc`,
  );
  await q(
    "Mensajes por día (hora Caracas)",
    sql`
      select (created_at at time zone 'America/Caracas')::date as dia,
             count(*) filter (where direction = 'in') as entrantes,
             count(*) filter (where direction = 'out') as salientes,
             count(*) filter (where direction = 'out' and status = 'failed') as fallidos,
             count(distinct phone_id) as telefonos
      from app.message
      where created_at > now() - make_interval(days => ${days})
      group by 1 order by 1`,
  );
  await q(
    "Latencia de respuesta (ms): todo vs. turnos del agente",
    sql`
      select case when tool_calls is not null then 'agente' else 'determinista' end as tipo,
             count(*) as n,
             percentile_cont(0.5) within group (order by latency_ms)::int as p50,
             percentile_cont(0.95) within group (order by latency_ms)::int as p95,
             max(latency_ms) as max
      from app.message
      where direction = 'out' and latency_ms is not null
        and created_at > now() - make_interval(days => ${days})
      group by 1 order by 1`,
  );
  await q(
    "Costo del LLM (USD)",
    sql`
      select count(*) as turnos,
             round(sum(cost_usd), 4) as total_usd,
             round(avg(cost_usd), 5) as promedio_usd,
             round(max(cost_usd), 5) as max_usd,
             sum(tokens_in) as tokens_in,
             sum(tokens_out) as tokens_out
      from app.message
      where cost_usd is not null and created_at > now() - make_interval(days => ${days})`,
  );
  await q(
    "Herramientas elegidas por el agente",
    sql`
      -- Una vez por turno: las marcas van en cada burbuja del turno.
      select tc->>'name' as herramienta, count(distinct coalesce(webhook_event_id, id)) as veces
      from app.message, jsonb_array_elements(tool_calls) tc
      where created_at > now() - make_interval(days => ${days})
      group by 1 order by 2 desc`,
  );
  await q(
    "Eventos del webhook por estado",
    sql`
      select status, count(*) as n, max(received_at) as ultimo
      from app.webhook_event
      where received_at > now() - make_interval(days => ${days})
      group by 1 order by 1`,
  );
  await q(
    "Movimientos guardados",
    sql`
      select business_date, count(*) as n, round(sum(amount_usd), 2) as usd, string_agg(distinct source_channel, ',') as canales
      from app.movement
      where deleted_at is null and created_at > now() - make_interval(days => ${days})
      group by 1 order by 1`,
  );
  await habits();
  await reminders();
  await signupRescue();
  await close();
})().catch(async (err) => {
  console.error(err);
  await close();
  process.exit(1);
});

/**
 * Hábito (PRD hábitos US-104, plan de medición M1–M3 y B4, alineado en ER-4): los mismos números
 * que la tarjeta "Hábito" de /admin (`habitStats` + `summarizeHabits`). Solo clientes (sin
 * "interna"), solo conteos. Los de la papelera cuentan donde el plan los cuenta (M2 hasta el día
 * del borrado, M3 en su cohorte).
 */
async function habits() {
  const now = new Date();
  const tenants = rows<{
    id: string;
    created_at: string;
    deleted_at: string | null;
    suspended_at: string | null;
    status: string;
  }>(
    await db.execute(sql`
      select id, created_at::text, deleted_at::text, suspended_at::text, status from app.tenant
      where not exists (select 1 from unnest(crm_tags) g where lower(btrim(g)) = 'interna')`),
  );
  const buckets = { "0": 0, "1": 0, "2-6": 0, "7-29": 0, "30+": 0 };
  const stats = [];
  for (const t of tenants) {
    const s = await db.transaction((tx) =>
      habitStats(
        tx,
        {
          id: t.id,
          createdAt: new Date(t.created_at),
          deletedAt: t.deleted_at ? new Date(t.deleted_at) : null,
          suspendedAt: t.suspended_at ? new Date(t.suspended_at) : null,
          status: t.status,
        },
        now,
      ),
    );
    stats.push(s);
    if (s.trashed) continue;
    const n = s.current;
    buckets[n === 0 ? "0" : n === 1 ? "1" : n < 7 ? "2-6" : n < 30 ? "7-29" : "30+"] += 1;
  }
  const h = summarizeHabits(stats);
  console.log("\n== Hábito: clientes por racha actual (sin papelera)");
  console.table([{ ...buckets, "7+": buckets["7-29"] + buckets["30+"] }]);
  console.log("\n== Hábito M1: activos 7 d con racha");
  console.table([
    {
      activos_7d: h.active,
      racha_2_6: h.streak2to6,
      racha_7plus: h.streak7,
      racha_30plus: h.streak30,
    },
  ]);
  console.log("\n== Hábito M2: días con registro (28 d hasta ayer) y días sin gastos (7 d)");
  console.table([
    {
      usuarios: h.users,
      dias_posibles: h.eligibleDays,
      dias_con_registro: h.recordDays,
      pct: h.eligibleDays ? Math.round((h.recordDays / h.eligibleDays) * 1000) / 10 : null,
      mediana_pct: h.medianPct,
      dias_sin_gastos_7d: h.noSpendDays7,
    },
  ]);
  console.log("\n== Hábito B4 (7 d): días-dueño con la ventana abierta a las 8 pm");
  console.table([
    {
      dias_dueno: h.ownerDays,
      ventana_abierta: h.windowOpen,
      sin_registro_aun: h.windowOpenNoRecord,
    },
  ]);
  console.log("\n== Hábito M3: retención por semana de registro");
  console.table(
    h.cohorts.map((c) => ({
      semana: c.week,
      registrados: c.signedUp,
      d7_maduros: c.d7Mature,
      d7_registro: c.d7Recorded,
      d7_escribio: c.d7Wrote,
      d30_maduros: c.d30Mature,
      d30_registro: c.d30Recorded,
      d30_registro_pago: c.d30RecordedPaid,
      d30_escribio: c.d30Wrote,
    })),
  );
  await q(
    "Hábito: tarjetas con la línea de racha (una por turno)",
    sql`
      select count(distinct coalesce(webhook_event_id, id)) as tarjetas_con_racha
      from app.message
      where tool_calls @> '[{"name": "habit_streak_line"}]'::jsonb
        and created_at > now() - make_interval(days => ${days})`,
  );
}

/**
 * Recordatorios (PRD hábitos US-311, N-9): por semana, las últimas 4 (ventanas de 7 días hacia
 * atrás). Solo clientes, solo conteos: nunca el texto, la contraparte ni el monto (F3-5).
 */
async function reminders() {
  const now = Date.now();
  const tenants = rows<{ id: string }>(
    await db.execute(sql`
      select id from app.tenant
      where not exists (select 1 from unnest(crm_tags) g where lower(btrim(g)) = 'interna')`),
  );
  const upTo = async (daysBack: number): Promise<ReminderStats> => {
    const since = new Date(now - daysBack * 86_400_000);
    const list: ReminderStats[] = [];
    for (const t of tenants)
      list.push(await db.transaction((tx) => reminderStats(tx, t.id, since)));
    return sumReminderStats(list);
  };
  const cumulative = [await upTo(7), await upTo(14), await upTo(21), await upTo(28)];
  const minus = (a: ReminderStats, b: ReminderStats): ReminderStats => {
    const out = { ...EMPTY_REMINDER_STATS };
    for (const k of Object.keys(out) as (keyof ReminderStats)[]) out[k] = a[k] - b[k];
    return out;
  };
  const weeks = cumulative.map((c, i) =>
    i === 0 ? c : minus(c, cumulative[i - 1] as ReminderStats),
  );
  console.log("\n== Recordatorios por semana (US-311, solo conteos)");
  console.table(
    weeks.map((w, i) => ({
      semana: i === 0 ? "últimos 7 d" : `hace ${i * 7}–${(i + 1) * 7} d`,
      creados: w.created,
      a: w.viaA,
      b: w.viaB,
      c: w.viaC,
      d: w.viaD,
      a_tiempo: w.onTime,
      hechos: w.done,
      enlazados: w.linked,
      borrados: w.cancelled,
      vencidos: w.expired,
      rech_no_plata: w.rejectedNonMoney,
      rech_tope: w.rejectedLimit,
      rech_empleado: w.rejectedEmployee,
      ediciones: w.edits,
    })),
  );
  console.log(
    `Dueños con 2 o más recordatorios (uso repetido): ${cumulative[0]?.repeatOwners ?? 0}`,
  );
}

/**
 * Registro: rescate (signup-reminders US-SR-10), por semana, las últimas 4. Solo conteos: nunca
 * un número ni un nombre. Brazos: window (A), template (B) y holdout (control).
 */
async function signupRescue() {
  const now = Date.now();
  const DAY = 86_400_000;
  const cfg = await signupRescueSettings(db);
  const since = cfg.inWindowSince ? new Date(cfg.inWindowSince).getTime() : null;
  const list = rows<{
    updated_at: string;
    completed_at: string | null;
    rescue_via: string | null;
    rescue_at: string | null;
  }>(
    await db.execute(sql`
      select updated_at, completed_at, rescue_via, rescue_at from app.signup
      where coalesce(rescue_at, updated_at) > now() - interval '35 days'`),
  );
  const t = (v: string | null) => (v ? new Date(v).getTime() : null);
  const weeks = [0, 1, 2, 3].map((i) => {
    const to = now - i * 7 * DAY;
    const from = to - 7 * DAY;
    const inWeek = (ms: number | null) => ms !== null && ms > from && ms <= to;
    const arm = (via: string) => list.filter((r) => r.rescue_via === via && inWeek(t(r.rescue_at)));
    const done = (rs: typeof list, within: number) =>
      rs.filter((r) => {
        const c = t(r.completed_at);
        const a = t(r.rescue_at);
        return c !== null && a !== null && c > a && c - a <= within;
      }).length;
    // De noche: vencía (3 h después) en horario nocturno y la ventana cerró antes de las 8:00.
    const night = list.filter((r) => {
      const u = t(r.updated_at) as number;
      const due = u + SIGNUP_RESCUE_AFTER_MS;
      if (
        r.rescue_via ||
        since === null ||
        u < since ||
        !inWeek(due) ||
        !isQuietHours(new Date(due))
      )
        return false;
      return r.completed_at === null || (t(r.completed_at) as number) > due;
    }).length;
    const w = arm("window");
    const b = arm("template");
    const h = arm("holdout");
    return { i, from, to, w, b, h, night, done };
  });
  const counts = await signupCountsByDay(
    db,
    new Date(now - 28 * DAY - 4 * 3_600_000).toISOString().slice(0, 10),
    new Date(now - 4 * 3_600_000).toISOString().slice(0, 10),
  );
  console.log("\n== Registro: rescate por semana (signup-reminders, solo conteos)");
  console.table(
    weeks.map(({ i, from, to, w, b, h, night, done }) => {
      const c = sumCounts(
        counts
          .filter((d) => {
            const ms = new Date(`${d.day}T16:00:00Z`).getTime();
            return ms > from && ms <= to + DAY;
          })
          .map((d) => d.counts),
      );
      const failed = Object.entries(c)
        .filter(([k]) => k.startsWith("failed:"))
        .map(([k, n]) => `${k.slice(7)}×${n}`)
        .join(" ");
      return {
        semana: i === 0 ? "últimos 7 d" : `hace ${i * 7}–${(i + 1) * 7} d`,
        elegibles: w.length + h.length + night,
        window: w.length,
        template: b.length,
        holdout: h.length,
        de_noche: night,
        fallidos: failed || "0",
        seguir: (c["resume:window"] ?? 0) + (c["resume:template"] ?? 0),
        no_me_escribas: Object.entries(c)
          .filter(([k]) => k.startsWith("stop:") || k === "stop_word")
          .reduce((a, [, n]) => a + n, 0),
        window_24h: done(w, DAY),
        window_7d: done(w, 7 * DAY),
        template_24h: done(b, DAY),
        template_7d: done(b, 7 * DAY),
        holdout_24h: done(h, DAY),
        holdout_7d: done(h, 7 * DAY),
      };
    }),
  );
}
