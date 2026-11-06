import { es, HABIT_DEFAULTS, habitSettings, REWARD_DEFAULTS, rewardSettings } from "@caja/core";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import "../legal.css";

const P = es.PUNTOS_PAGE;

/** La descripción cambia con las invitaciones (v1.2 S-3), como el resto de la página. */
export async function generateMetadata(): Promise<Metadata> {
  const { flags, rewards } = await settings();
  return {
    title: P.title,
    description: invitesShown(flags, rewards) ? P.descriptionReferrals : P.description,
  };
}

/** P-16: las líneas de invitación quedan una vez que `referrals` estuvo encendido. */
function invitesShown(
  flags: { referrals: boolean },
  rewards: { referralsOnSince: string | null },
): boolean {
  return flags.referrals || Boolean(rewards.referralsOnSince);
}

/**
 * Reglas públicas de los puntos (PRD hábitos v4.2.1 US-431, RW9 de los textos v1.2): sin sesión
 * ni cookies (SEC-P4-4). Se arma con los interruptores `habits` cada 5 minutos, así el texto
 * siempre es verdad: sin `dailyClose` no habla del cierre; las invitaciones, desde que
 * `referrals` se encendió una vez (P-16).
 * «Última actualización» = lo más nuevo entre el texto y los cambios de `dailyClose` o
 * `referrals` (P-16, F-3).
 */
export const revalidate = 300;

/** Sin base (por ejemplo, durante el build): los valores por defecto. */
async function settings() {
  try {
    const [flags, rewards] = await Promise.all([habitSettings(db()), rewardSettings(db())]);
    return { flags, rewards };
  } catch {
    return { flags: HABIT_DEFAULTS, rewards: REWARD_DEFAULTS };
  }
}

export default async function Puntos() {
  const { flags, rewards } = await settings();
  const rules = es.pointsRules({
    dailyClose: flags.dailyClose,
    referrals: invitesShown(flags, rewards),
  });
  const updated = es.rulesUpdatedOn([rewards.dailyCloseChangedOn, rewards.referralsChangedOn]);
  return (
    <main className="legal">
      <h1>{P.h1}</h1>
      <p>{P.lead}</p>

      <h2>{P.levelsTitle}</h2>
      <ul>
        {([1, 2, 3, 4, 5] as const).map((l) => (
          <li key={l}>{es.levelLinePlain(l)}</li>
        ))}
      </ul>

      <h2>{P.rulesTitle}</h2>
      <ol>
        {rules.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ol>

      <p className="updated">Última actualización: {es.formatRulesDate(updated)}</p>
    </main>
  );
}
