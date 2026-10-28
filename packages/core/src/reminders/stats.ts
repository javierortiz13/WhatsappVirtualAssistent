import { rows, sql, type Tx } from "@caja/db";

/**
 * Números de recordatorios de un negocio en una ventana (PRD hábitos US-311, N-9): para
 * `pnpm metrics` y /admin. Solo conteos: nunca el texto, la contraparte ni el monto (F3-5).
 */
export type ReminderStats = {
  created: number;
  /** Entregados por camino (a: a su hora, b: aviso adelantado, c: al escribir, d: plantilla). */
  viaA: number;
  viaB: number;
  viaC: number;
  viaD: number;
  /** A tiempo: a o d ≤ 10 min después de `due_at`. */
  onTime: number;
  done: number;
  /** Cumplidos por un registro (US-307). */
  linked: number;
  cancelled: number;
  expired: number;
  /** `reminder_rejected` por motivo (E-6), una vez por turno. */
  rejectedNonMoney: number;
  rejectedLimit: number;
  rejectedEmployee: number;
  /** Ediciones (Corregir por chat o Editar en el panel, E-10). */
  edits: number;
  /** Dueños con 2 o más recordatorios en total (uso repetido). */
  repeatOwners: number;
};

export const EMPTY_REMINDER_STATS: ReminderStats = {
  created: 0,
  viaA: 0,
  viaB: 0,
  viaC: 0,
  viaD: 0,
  onTime: 0,
  done: 0,
  linked: 0,
  cancelled: 0,
  expired: 0,
  rejectedNonMoney: 0,
  rejectedLimit: 0,
  rejectedEmployee: 0,
  edits: 0,
  repeatOwners: 0,
};

/** Dentro de `withTenant` (RLS). `since` abre la ventana; todo lo de antes no cuenta. */
export async function reminderStats(tx: Tx, tenantId: string, since: Date): Promise<ReminderStats> {
  const [r] = rows<Record<keyof ReminderStats, number>>(
    await tx.execute(sql`
      with rem as (select * from app.reminder where tenant_id = ${tenantId}),
      rejected as (
        select args->>'reason' as reason, count(distinct coalesce(m.webhook_event_id, m.id))::int as n
        from app.message m, jsonb_array_elements(
          case when jsonb_typeof(m.tool_calls) = 'array' then m.tool_calls else '[]'::jsonb end
        ) c, lateral (select c->'args' as args) a
        where m.tenant_id = ${tenantId} and m.direction = 'out' and m.created_at >= ${since}
          and c->>'name' = 'reminder_rejected'
        group by 1
      )
      select
        (select count(*)::int from rem where created_at >= ${since}) as "created",
        (select count(*)::int from rem where delivered_via = 'a' and delivered_at >= ${since}) as "viaA",
        (select count(*)::int from rem where early_sent_at >= ${since}) as "viaB",
        (select count(*)::int from rem where delivered_via = 'c' and delivered_at >= ${since}) as "viaC",
        (select count(*)::int from rem where delivered_via = 'd' and delivered_at >= ${since}) as "viaD",
        (select count(*)::int from rem where delivered_via in ('a', 'd') and delivered_at >= ${since}
           and delivered_at <= due_at + interval '10 minutes') as "onTime",
        (select count(*)::int from rem where status = 'done' and done_at >= ${since}) as "done",
        (select count(*)::int from rem where status = 'done' and done_at >= ${since}
           and linked_movement_id is not null) as "linked",
        (select count(*)::int from rem where status = 'cancelled' and updated_at >= ${since}) as "cancelled",
        (select count(*)::int from rem where status = 'expired' and updated_at >= ${since}) as "expired",
        coalesce((select n from rejected where reason = 'non_money'), 0) as "rejectedNonMoney",
        coalesce((select n from rejected where reason = 'limit'), 0) as "rejectedLimit",
        coalesce((select n from rejected where reason = 'employee'), 0) as "rejectedEmployee",
        (select count(*)::int from app.audit_log where tenant_id = ${tenantId}
           and action = 'reminder_update' and created_at >= ${since}) as "edits",
        (select count(*)::int from (select phone_id from rem group by phone_id having count(*) >= 2) x)
          as "repeatOwners"
    `),
  );
  return { ...EMPTY_REMINDER_STATS, ...(r ?? {}) };
}

export function sumReminderStats(list: ReminderStats[]): ReminderStats {
  const out = { ...EMPTY_REMINDER_STATS };
  const keys = Object.keys(out) as (keyof ReminderStats)[];
  for (const s of list) {
    for (const k of keys) out[k] += s[k];
  }
  return out;
}
