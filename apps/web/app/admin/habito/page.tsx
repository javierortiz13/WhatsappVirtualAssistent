import { habitSettings } from "@caja/core";
import { loadHabits, loadNudgeStats, loadReminderStats } from "@/lib/admin";
import { db } from "@/lib/db";
import { getAdmin, getNow, getTenants } from "../data";
import { errorText, OK, type SectionParams } from "../messages";
import { HabitoView } from "../views/habito";

/** /admin/habito: los mismos conteos de antes, en fichas y listas. */
export default async function AdminHabito({
  searchParams,
}: {
  searchParams: Promise<SectionParams>;
}) {
  await getAdmin();
  const sp = await searchParams;
  const now = getNow();
  const tenants = await getTenants();
  const [habits, flags, reminders, nudges, offs, reminders14] = await Promise.all([
    loadHabits(tenants, now),
    habitSettings(db()),
    loadReminderStats(tenants, now),
    loadNudgeStats(tenants, now),
    // G1-3: las señales para frenar, a 14 días.
    loadNudgeStats(tenants, now, 14),
    loadReminderStats(tenants, now, 14),
  ]);
  return (
    <HabitoView
      banner={{ ok: sp.ok ? (OK[sp.ok] ?? null) : null, error: errorText(sp.error) }}
      habits={habits}
      nudges={
        nudges && (flags.nudge || nudges.sent > 0 || nudges.closes > 0 || nudges.optedIn > 0)
          ? nudges
          : null
      }
      offs={offs && flags.prefs ? offs : null}
      reminders={reminders && (flags.reminders || reminders.created > 0) ? reminders : null}
      reminders14={reminders14}
    />
  );
}
