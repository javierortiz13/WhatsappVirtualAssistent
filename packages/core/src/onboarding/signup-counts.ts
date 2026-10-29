import { type Queryable, rows, sql } from "@caja/db";
import { businessDateOf } from "../domain/dates";

/**
 * Contadores diarios del registro por WhatsApp (signup-reminders US-SR-10), en `app_setting`
 * (`signup_counts:<fecha de Caracas>`). Solo números: nunca quién ni qué escribió.
 *
 * - `sends`: mensajes de servicio del registro (no se guardan en `message`; P-19, cupo de Meta).
 * - `template_sends`: plantillas del registro (se cobran aparte, como marketing).
 * - `resume:<via>`, `stop:<via>`: toques de «Seguir» / «No me escribas» según el rescate de la fila
 *   (`window`, `template`, `holdout` o `none`); `stop_word`: «no me escribas» escrito.
 * - `failed:<código>`: envíos del recordatorio que Meta rechazó.
 */
export type SignupCounts = Record<string, number>;

const PREFIX = "signup_counts:";

/** Suma `delta` al contador del día, en una sola sentencia (dos procesos no se pisan). */
export async function bumpSignupCounts(
  db: Queryable,
  now: Date,
  delta: SignupCounts,
): Promise<void> {
  const clean = Object.fromEntries(Object.entries(delta).filter(([, n]) => n));
  if (!Object.keys(clean).length) return;
  const key = `${PREFIX}${businessDateOf(now)}`;
  const value = JSON.stringify(clean);
  await db.execute(sql`
    insert into app.app_setting (key, value, updated_at, updated_by)
    values (${key}, ${value}::jsonb, ${now.toISOString()}::timestamptz, 'contador')
    on conflict (key) do update set
      value = (
        select jsonb_object_agg(k, coalesce((app.app_setting.value->>k)::int, 0)
                                 + coalesce((excluded.value->>k)::int, 0))
        from jsonb_object_keys(app.app_setting.value || excluded.value) as k
      ),
      updated_at = excluded.updated_at
  `);
}

/** Los contadores de cada día entre `from` y `to` (fechas de Caracas, inclusive). */
export async function signupCountsByDay(
  db: Queryable,
  from: string,
  to: string,
): Promise<{ day: string; counts: SignupCounts }[]> {
  const r = rows<{ key: string; value: SignupCounts }>(
    await db.execute(sql`
      select key, value from app.app_setting
      where key >= ${`${PREFIX}${from}`} and key <= ${`${PREFIX}${to}`}
      order by key
    `),
  );
  return r.map((x) => ({ day: x.key.slice(PREFIX.length), counts: x.value }));
}

export function sumCounts(list: SignupCounts[]): SignupCounts {
  const out: SignupCounts = {};
  for (const c of list) for (const [k, n] of Object.entries(c)) out[k] = (out[k] ?? 0) + Number(n);
  return out;
}
