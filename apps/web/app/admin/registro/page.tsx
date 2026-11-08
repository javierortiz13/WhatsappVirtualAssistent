import {
  batchAlreadyRan,
  batchSchedule,
  nextBatchSlot,
  planSignupBatch,
  SCHEDULE_LEAD_MAX_MS,
} from "@caja/core";
import { businessDateOf, formatShortDate } from "@caja/core/domain";
import { db } from "@/lib/db";
import { getAdmin, getFunnel, getNow } from "../data";
import { toContact } from "../derive";
import { errorText, OK, type SectionParams } from "../messages";
import { RegistroView } from "../views/registro";

/** «mar 10/11 10:00» de Caracas. */
const when = (iso: string) => `${formatShortDate(businessDateOf(new Date(iso)))} 10:00`;

/** /admin/registro: registros sin terminar, sus números y el lote de la plantilla. */
export default async function AdminRegistro({
  searchParams,
}: {
  searchParams: Promise<SectionParams>;
}) {
  await getAdmin();
  const sp = await searchParams;
  const now = getNow();
  const funnel = await getFunnel();
  // Lote de la plantilla del registro (A-0031): programado, ya corrido o lo que saldría ahora.
  const [schedule, ran] = await Promise.all([batchSchedule(db()), batchAlreadyRan(db())]);
  const plan =
    !ran && schedule?.status !== "scheduled" && schedule?.status !== "running"
      ? await planSignupBatch(db(), { now, maxAgeDays: 30, parkNumbers: [] }).catch(() => null)
      : null;
  const next = nextBatchSlot(now);
  return (
    <RegistroView
      banner={{ ok: sp.ok ? (OK[sp.ok] ?? null) : null, error: errorText(sp.error, sp.motivo) }}
      abandoned={funnel.abandoned}
      toContact={toContact(funnel.abandoned).length}
      rescue={funnel.rescue}
      lote={{
        schedule,
        ran,
        plan: plan ? { toSend: plan.toSend, eligible: plan.eligible, costUsd: plan.costUsd } : null,
        nextWhen: when(next.toISOString()),
        scheduledWhen: schedule?.status === "scheduled" ? when(schedule.at) : null,
        inLeadWindow: next.getTime() - now.getTime() <= SCHEDULE_LEAD_MAX_MS,
      }}
      now={now}
    />
  );
}
