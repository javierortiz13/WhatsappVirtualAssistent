import { type Queryable, rows, sql } from "@caja/db";
import { rewardSettings } from "../billing/rewards";
import { type HabitHistoryEntry, habitHistory, habitSettings } from "../ledger/habits";

/**
 * Cuándo se encendieron `xp`, `rewards`, `referrals` y `dailyClose`, y si fue desde /admin o desde
 * el sistema (10/11, para A-0038 y A-0039). Solo fechas y «/admin» o «sistema»: nunca un correo,
 * un nombre, un número ni un id. Se cruzan cuatro fuentes, porque el historial de interruptores
 * (G1-4) solo existe desde su deploy:
 * - el historial de interruptores (`habits_history`): fecha, hora y quién, de cada cambio;
 * - las fechas que guarda `rewards` al cambiar un interruptor (día de Caracas);
 * - el último cambio de cada ajuste (`app_setting.updated_at` y `updated_by`);
 * - la primera huella en los datos (primer punto, primer regalo, primera invitación, primer cierre).
 */
export type FlagKey = "xp" | "rewards" | "referrals" | "dailyClose";
export const FLAG_DATE_KEYS: FlagKey[] = ["xp", "rewards", "referrals", "dailyClose"];

export type FlagDateRow = {
  flag: FlagKey;
  /** Encendido ahora. */
  on: boolean;
  /** Primer encendido del historial (G1-4): instante ISO y quién. */
  firstOn: { at: string; by: string } | null;
  /** Último encendido del historial. */
  lastOn: { at: string; by: string } | null;
  /** Último apagado del historial. */
  lastOff: { at: string; by: string } | null;
  /** Día que guarda `rewards` (xpOnSince, referralsOnSince, dailyCloseChangedOn…). */
  savedDay: string | null;
  /** Primera huella en los datos (instante ISO). */
  firstTrace: string | null;
};

export type FlagDates = {
  flags: FlagDateRow[];
  /** Último cambio de cada ajuste: instante ISO y quién. */
  lastChange: {
    habits: { at: string; by: string } | null;
    rewards: { at: string; by: string } | null;
  };
};

/** «/admin» si lo guardó un administrador (su correo), «sistema» si fue el sistema; nunca el correo. */
export function whoChanged(by: string | null | undefined): string {
  if (!by) return "—";
  if (by.includes("@")) return "/admin";
  if (/^(system|sistema)$/i.test(by.trim())) return "sistema";
  // Otras etiquetas (la limpieza aprobada, una prueba): se dicen como «sistema (etiqueta)», recortadas.
  return `sistema (${by.replace(/[^\p{L}\p{N} ./()-]/gu, "").slice(0, 60)})`;
}

const iso = (d: Date | string | null | undefined) =>
  d ? (d instanceof Date ? d : new Date(d)).toISOString() : null;

export async function flagOnDates(db: Queryable): Promise<FlagDates> {
  const habits = await habitSettings(db);
  const rewards = await rewardSettings(db);
  const history: HabitHistoryEntry[] = (await habitHistory(db, 200)).reverse();
  const meta = rows<{ key: string; updated_at: Date | string; updated_by: string | null }>(
    await db.execute(
      sql`select key, updated_at, updated_by from app.app_setting where key in ('habits', 'rewards')`,
    ),
  );
  const [trace] = rows<{
    xp: Date | string | null;
    rewards: Date | string | null;
    referrals: Date | string | null;
    daily_close: Date | string | null;
  }>(
    await db.execute(sql`
      select
        (select min(created_at) from app.points_event) as xp,
        (select min(created_at) from app.reward_grant) as rewards,
        (select min(created_at) from app.referral) as referrals,
        (select min(created_at) from app.message
          where direction = 'out' and tool_calls @> '[{"name":"habit_close"}]'::jsonb) as daily_close`),
  );
  const saved: Record<FlagKey, string | null> = {
    xp: rewards.xpOnSince,
    rewards: null,
    referrals: rewards.referralsOnSince ?? rewards.referralsChangedOn,
    dailyClose: rewards.dailyCloseChangedOn,
  };
  const traces: Record<FlagKey, string | null> = {
    xp: iso(trace?.xp),
    rewards: iso(trace?.rewards),
    referrals: iso(trace?.referrals),
    dailyClose: iso(trace?.daily_close),
  };
  const changeOf = (key: string) => {
    const m = meta.find((r) => r.key === key);
    return m ? { at: iso(m.updated_at) as string, by: whoChanged(m.updated_by) } : null;
  };
  return {
    flags: FLAG_DATE_KEYS.map((flag) => {
      const ons = history.filter((h) => h.changed[flag]?.[1] === true);
      const offs = history.filter((h) => h.changed[flag]?.[1] === false);
      const at = (h: HabitHistoryEntry | undefined) =>
        h ? { at: h.at, by: whoChanged(h.by) } : null;
      return {
        flag,
        on: Boolean(habits[flag]),
        firstOn: at(ons[0]),
        lastOn: at(ons.at(-1)),
        lastOff: at(offs.at(-1)),
        savedDay: saved[flag],
        firstTrace: traces[flag],
      };
    }),
    lastChange: { habits: changeOf("habits"), rewards: changeOf("rewards") },
  };
}
