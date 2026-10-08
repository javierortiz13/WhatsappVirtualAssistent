import { and, eq, rows, schema, sql, type Tx } from "@caja/db";
import { businessDateOf } from "../domain/dates";
import { Decimal } from "../domain/money";

/**
 * Uso del mes (hora Caracas) de un negocio, para el límite del plan y el panel. Cuenta como
 * "registro" cada mensaje que el usuario manda al asistente; las respuestas y reacciones no.
 */
export type MonthUsage = {
  month: string;
  inbound: number;
  /** Mensajes de servicio enviados (las reacciones no se cobran por separado). */
  outbound: number;
  aiCostUsd: Decimal;
  aiTurns: number;
  phones: number;
};

/** "2026-10" y el instante en que empezó ese mes en Caracas (UTC-4, sin horario de verano). */
export function caracasMonth(now: Date): { key: string; start: Date } {
  const key = businessDateOf(now).slice(0, 7);
  return { key, start: new Date(`${key}-01T04:00:00Z`) };
}

export async function monthUsage(tx: Tx, tenantId: string, now: Date): Promise<MonthUsage> {
  const { key, start } = caracasMonth(now);
  const [m] = rows<{
    inbound: number | string;
    outbound: number | string;
    ai_cost: string | null;
    ai_turns: number | string;
  }>(
    await tx.execute(sql`
      -- Los toques de botón (Guardar, Corregir, renovar…) y las reacciones no cuentan como
      -- mensajes (08/10): no usan IA y son parte del mismo registro.
      select count(*) filter (where direction = 'in' and kind not in ('interactive', 'reaction')) as inbound,
             count(*) filter (where direction = 'out' and kind <> 'reaction') as outbound,
             coalesce(sum(cost_usd), 0)::text as ai_cost,
             count(*) filter (where cost_usd is not null) as ai_turns
      from ${schema.message}
      where tenant_id = ${tenantId} and created_at >= ${start.toISOString()}::timestamptz
    `),
  );
  const phones = await tx
    .select({ id: schema.phoneNumber.id })
    .from(schema.phoneNumber)
    .where(and(eq(schema.phoneNumber.tenantId, tenantId), eq(schema.phoneNumber.status, "active")));
  return {
    month: key,
    inbound: Number(m?.inbound ?? 0),
    outbound: Number(m?.outbound ?? 0),
    aiCostUsd: new Decimal(m?.ai_cost ?? 0),
    aiTurns: Number(m?.ai_turns ?? 0),
    phones: phones.length,
  };
}
