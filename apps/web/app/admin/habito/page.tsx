import {
  habitSettings,
  nextBatchSlot,
  planReaskBatch,
  reaskAlreadyRan,
  reaskSchedule,
  reengageOn,
  SCHEDULE_LEAD_MAX_MS,
} from "@caja/core";
import { businessDateOf, formatShortDate } from "@caja/core/domain";
import { loadHabits, loadNudgeStats, loadReengage, loadReminderStats } from "@/lib/admin";
import { db } from "@/lib/db";
import { getAdmin, getNow, getTenants } from "../data";
import { errorText, OK, type SectionParams } from "../messages";
import { HabitoView } from "../views/habito";

/** «mar 10/11 10:00» de Caracas. */
const when = (iso: string) => `${formatShortDate(businessDateOf(new Date(iso)))} 10:00`;

/** /admin/habito: los mismos conteos de antes, en fichas y listas, más la retención E1–E3. */
export default async function AdminHabito({
  searchParams,
}: {
  searchParams: Promise<SectionParams>;
}) {
  await getAdmin();
  const sp = await searchParams;
  const now = getNow();
  const tenants = await getTenants();
  const [habits, flags, reminders, nudges, offs, reminders14, retencion, schedule, ran] =
    await Promise.all([
      loadHabits(tenants, now),
      habitSettings(db()),
      loadReminderStats(tenants, now),
      loadNudgeStats(tenants, now),
      // G1-3: las señales para frenar, a 14 días.
      loadNudgeStats(tenants, now, 14),
      loadReminderStats(tenants, now, 14),
      loadReengage(tenants, now),
      reaskSchedule(db()).catch(() => null),
      reaskAlreadyRan(db()).catch(() => false),
    ]);
  // E3-t (A-0053): la simulación, solo mientras no corrió ni hay uno programado.
  const plan =
    !ran && schedule?.status !== "scheduled" && schedule?.status !== "running"
      ? await planReaskBatch(db(), { now }).catch(() => null)
      : null;
  const next = nextBatchSlot(now);
  return (
    <HabitoView
      banner={{ ok: sp.ok ? (OK[sp.ok] ?? null) : null, error: errorText(sp.error, sp.motivo) }}
      habits={habits}
      nudges={
        nudges && (flags.nudge || nudges.sent > 0 || nudges.closes > 0 || nudges.optedIn > 0)
          ? nudges
          : null
      }
      offs={offs && flags.prefs ? offs : null}
      reminders={reminders && (flags.reminders || reminders.created > 0) ? reminders : null}
      reminders14={reminders14}
      retencion={retencion}
      reask={{
        schedule,
        ran,
        plan: plan
          ? {
              toSend: plan.toSend,
              eligible: plan.eligible,
              costUsd: plan.costUsd,
              excluded: plan.excluded,
            }
          : null,
        nextWhen: when(next.toISOString()),
        scheduledWhen: schedule?.status === "scheduled" ? when(schedule.at) : null,
        inLeadWindow: next.getTime() - now.getTime() <= SCHEDULE_LEAD_MAX_MS,
        on: reengageOn(flags),
      }}
    />
  );
}
