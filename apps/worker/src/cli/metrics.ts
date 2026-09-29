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

(async () => {
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
