import {
  habitHistory,
  habitSettings,
  rewardSettings,
  signupFlowSettings,
  signupRescueSettings,
} from "@caja/core";
import type { FlagState } from "@caja/core/admin-flags";
import { db } from "@/lib/db";
import { getAdmin } from "../data";
import { flagViews } from "../derive";
import { errorText, OK, type SectionParams } from "../messages";
import { InterruptoresView } from "../views/interruptores";

/** /admin/interruptores: todos los flags, cada uno con su hoja de confirmación. */
export default async function AdminInterruptores({
  searchParams,
}: {
  searchParams: Promise<SectionParams>;
}) {
  await getAdmin();
  const sp = await searchParams;
  const [h, r, f, rs, history] = await Promise.all([
    habitSettings(db()),
    signupRescueSettings(db()),
    signupFlowSettings(db()),
    rewardSettings(db()),
    habitHistory(db(), 10),
  ]);
  const state: FlagState = {
    streakLine: h.streakLine,
    noSpend: h.noSpend,
    prefs: h.prefs,
    nudge: h.nudge,
    dailyClose: h.dailyClose,
    reminders: h.reminders,
    xp: h.xp,
    rewards: h.rewards,
    referrals: h.referrals,
    inWindow: r.inWindow,
    template: r.template,
    viaTemplate: r.inWindowVia === "template",
    signupFast: f.fast,
  };
  return (
    <InterruptoresView
      banner={{ ok: sp.ok ? (OK[sp.ok] ?? null) : null, error: errorText(sp.error) }}
      habits={flagViews("habits", state)}
      rewards={flagViews("rewards", state)}
      rescue={flagViews("rescue", state)}
      signupFlow={flagViews("signupFlow", state)}
      ceiling={rs.monthlyCeilingUsd.toFixed(2)}
      history={history}
    />
  );
}
