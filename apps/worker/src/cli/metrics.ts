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

/** Tarifa por mensaje de servicio (Meta, "Rest of Latin America"). Ajustable: META_MSG_RATE_USD. */
const rate = Number(process.env.META_MSG_RATE_USD ?? "0.013");
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
      c as (
        select count(*) filter (where direction = 'out' and kind <> 'reaction' and status in ('ok', 'sending')) as enviados,
               count(*) filter (where direction = 'out' and kind = 'reaction' and status in ('ok', 'sending')) as reacciones,
               count(*) filter (where direction = 'in') as entrantes
        from m
      )
      select c.enviados, c.reacciones, c.entrantes,
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
      select tc->>'name' as herramienta, count(*) as veces
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
  await close();
})().catch(async (err) => {
  console.error(err);
  await close();
  process.exit(1);
});
