import type { HabitHistoryEntry } from "@caja/core";
import { saveHabitsAction, saveRewardsAction, saveSignupRescueAction } from "../actions";
import { Banner, Card, Head } from "../ui/bits";
import { FlagGroup, type FlagView } from "../ui/flag-group";

export type InterruptoresData = {
  banner: { ok: string | null; error: string | null };
  habits: FlagView[];
  rewards: FlagView[];
  rescue: FlagView[];
  /** El tope de regalos va igual con los interruptores de puntos (misma server action). */
  ceiling: string;
  history: HabitHistoryEntry[];
  /** Solo para las capturas: una hoja abierta. */
  open?: { group: "habits" | "rewards" | "rescue"; field: string; code?: string };
};

const FLAG_NAME: Record<string, string> = {
  streakLine: "Línea de racha",
  noSpend: "«Hoy no gasté nada»",
  prefs: "Avisos",
  nudge: "Aviso de las 8 pm",
  dailyClose: "8 pm para todos",
  reminders: "Recordatorios",
  xp: "Puntos",
  rewards: "Premios",
  referrals: "Invitaciones",
};

const when = (iso: string) => {
  const c = new Date(new Date(iso).getTime() - 4 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(c.getUTCDate())}/${p(c.getUTCMonth() + 1)} ${p(c.getUTCHours())}:${p(c.getUTCMinutes())}`;
};

/**
 * /admin/interruptores: cada interruptor se guarda solo al confirmar en su hoja. Los que dependen
 * de otro quedan con 🔒; los que piden aprobación de la agencia, con su código y su estado.
 */
export function InterruptoresView(d: InterruptoresData) {
  const o = (g: "habits" | "rewards" | "rescue") =>
    d.open?.group === g
      ? { field: d.open.field, ...(d.open.code ? { code: d.open.code } : {}) }
      : undefined;
  return (
    <>
      <Head
        title="Interruptores"
        sub="Para todos los clientes. Cada cambio pide confirmar y aplica desde el próximo mensaje."
      />
      <Banner ok={d.banner.ok} error={d.banner.error} />
      <Card title="Hábito">
        <FlagGroup action={saveHabitsAction} flags={d.habits} open={o("habits")} />
      </Card>
      <Card title="Puntos e invitaciones">
        <FlagGroup
          action={saveRewardsAction}
          flags={d.rewards}
          hidden={{ ceiling: d.ceiling, from: "interruptores" }}
          open={o("rewards")}
        />
      </Card>
      <Card title="Registro">
        <FlagGroup action={saveSignupRescueAction} flags={d.rescue} open={o("rescue")} />
      </Card>
      <p className="ad-note">
        Enciéndelos solo con su aprobación. Si algo sale mal, apágalo aquí el mismo día.
      </p>
      {d.history.length ? (
        <Card title="Últimos cambios">
          <ul className="ad-tline">
            {d.history.flatMap((h) =>
              Object.entries(h.changed).map(([flag, change]) => (
                <li key={`${h.at}-${flag}`}>
                  <span>
                    {FLAG_NAME[flag] ?? flag}: {change?.[0] ? "encendido" : "apagado"} →{" "}
                    {change?.[1] ? "encendido" : "apagado"}
                    <br />
                    <span className="w">
                      {when(h.at)}, {h.by}
                      {h.approval ? `, con ${h.approval}` : ""}
                    </span>
                  </span>
                </li>
              )),
            )}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
