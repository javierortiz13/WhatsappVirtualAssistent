import { rows, sql, type Tx } from "@caja/db";
import { type Level, levelKind } from "../billing/rewards";
import { caracasMonth } from "../billing/usage";
import { addDays, businessDateOf } from "../domain/dates";

/**
 * «Puntos y premios» (PRD hábitos v4.2.1 §P4.9, US-429/US-430): filas 1–3 y 7, por negocio y luego
 * sumadas. Solo conteos y dólares reservados: nunca un nombre, un número, un texto ni un monto de
 * un movimiento. Los mismos números en /admin y en `pnpm metrics`.
 */
export type PointsStats = {
  /** Fila 1: puntos dados (suma de los positivos) este mes y en 14 días; reversas (filas). */
  pointsMonth: number;
  points14: number;
  awarded14: boolean;
  reversals: number;
  /** Fila 2: nivel actual y subidas de nivel este mes (por nivel). */
  level: Level;
  levelUpsMonth: Record<2 | 3 | 4 | 5, number>;
  /** Fila 3: costo de los regalos aplicados este mes, por tipo; los que esperan, por razón. */
  bookedByType: { messages: number; trial_days: number; week: number };
  waiting: { ceiling: number; not_paying: number; flag_off: number; paused: number };
  ceilingHitsMonth: number;
  ceilingHitsLastMonth: number;
  /** Fila 7 (S2–S5, 14 días): ráfaga ≥ 6 en 10 min; < $0.10; mismo monto en 60 min; borrado otro día. */
  s2Burst: boolean;
  s3Tiny: number;
  records14: number;
  s4SameAmount: number;
  s5LaterDelete: number;
};

export async function pointsStats(tx: Tx, tenantId: string, now: Date): Promise<PointsStats> {
  const month = caracasMonth(now).key;
  const since14 = addDays(businessDateOf(now), -13);
  const [prevY, prevM] = month.split("-").map(Number) as [number, number];
  const lastMonth =
    prevM === 1 ? `${prevY - 1}-12` : `${prevY}-${String(prevM - 1).padStart(2, "0")}`;
  const [p] = rows<{
    month: string;
    d14: string;
    rev: string;
    level: number;
  }>(
    await tx.execute(sql`
      select
        coalesce(sum(points) filter (where points > 0
          and to_char(business_date, 'YYYY-MM') = ${month}), 0)::text as month,
        coalesce(sum(points) filter (where points > 0 and business_date >= ${since14}::date), 0)::text
          as d14,
        count(*) filter (where points < 0)::text as rev,
        (select points_level from app.tenant where id = ${tenantId}) as level
      from app.points_event where tenant_id = ${tenantId}
    `),
  );
  const grants = rows<{
    kind: string;
    status: string;
    wait_reason: string | null;
    applied_as: string | null;
    cost: string;
    booked_month: string | null;
    created_month: string;
    hit_month: string | null;
  }>(
    await tx.execute(sql`
      select kind, status, wait_reason, applied_as, cost_usd_estimate::text as cost, booked_month,
             to_char(created_at at time zone 'America/Caracas', 'YYYY-MM') as created_month,
             flags->>'ceilingHitMonth' as hit_month
      from app.reward_grant where tenant_id = ${tenantId}
    `),
  );
  const [a] = rows<{ burst: boolean; tiny: string; total: string; same: string; later: string }>(
    await tx.execute(sql`
      with m as (
        select type, amount_usd, created_at, deleted_at from app.movement
        where tenant_id = ${tenantId}
          and (created_at at time zone 'America/Caracas')::date >= ${since14}::date
      )
      select
        exists (select 1 from m a where (select count(*) from m b
                  where b.created_at between a.created_at and a.created_at + interval '10 minutes') >= 6)
          as burst,
        count(*) filter (where amount_usd < 0.10)::text as tiny,
        count(*)::text as total,
        (select count(*) from m a join m b on a.type = b.type and a.amount_usd = b.amount_usd
           and b.created_at > a.created_at and b.created_at <= a.created_at + interval '60 minutes')::text
          as same,
        count(*) filter (where deleted_at is not null
          and (deleted_at at time zone 'America/Caracas')::date
            > (created_at at time zone 'America/Caracas')::date)::text as later
      from m
    `),
  );
  const levelUpsMonth = { 2: 0, 3: 0, 4: 0, 5: 0 } as Record<2 | 3 | 4 | 5, number>;
  for (const l of [2, 3, 4, 5] as const)
    levelUpsMonth[l] = grants.filter(
      (g) => g.kind === levelKind(l) && g.created_month === month,
    ).length;
  const bookedByType = { messages: 0, trial_days: 0, week: 0 };
  const waiting = { ceiling: 0, not_paying: 0, flag_off: 0, paused: 0 };
  for (const g of grants) {
    if (
      g.status === "applied" &&
      g.booked_month === month &&
      g.applied_as &&
      g.applied_as in bookedByType
    )
      bookedByType[g.applied_as as keyof typeof bookedByType] += Number(g.cost);
    if (g.status === "waiting" && g.wait_reason && g.wait_reason in waiting)
      waiting[g.wait_reason as keyof typeof waiting] += 1;
  }
  return {
    pointsMonth: Number(p?.month ?? 0),
    points14: Number(p?.d14 ?? 0),
    awarded14: Number(p?.d14 ?? 0) > 0,
    reversals: Number(p?.rev ?? 0),
    level: (p?.level ?? 1) as Level,
    levelUpsMonth,
    bookedByType,
    waiting,
    ceilingHitsMonth: grants.filter((g) => g.hit_month === month).length,
    ceilingHitsLastMonth: grants.filter((g) => g.hit_month === lastMonth).length,
    s2Burst: a?.burst === true,
    s3Tiny: Number(a?.tiny ?? 0),
    records14: Number(a?.total ?? 0),
    s4SameAmount: Number(a?.same ?? 0),
    s5LaterDelete: Number(a?.later ?? 0),
  };
}

export type PointsSummary = {
  owners: number;
  pointsMonth: number;
  points14: number;
  ownersAwarded14: number;
  reversals: number;
  /** Dueños por nivel; null si alguno tiene menos de 5 (celdas chicas: solo el total). */
  byLevel: Record<Level, number> | null;
  levelUpsMonth: Record<2 | 3 | 4 | 5, number> | null;
  levelUpsMonthTotal: number;
  bookedByType: { messages: number; trial_days: number; week: number };
  waiting: { ceiling: number; not_paying: number; flag_off: number; paused: number };
  ceilingHitsMonth: number;
  ceilingHitsLastMonth: number;
  s2BurstTenants: number;
  s3Tiny: number;
  records14: number;
  s4SameAmount: number;
  s5LaterDelete: number;
};

const SMALL = 5;

export function summarizePoints(list: PointsStats[]): PointsSummary {
  const sum = (f: (s: PointsStats) => number) => list.reduce((n, s) => n + f(s), 0);
  const byLevel = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<Level, number>;
  for (const s of list) byLevel[s.level] += 1;
  const ups = { 2: 0, 3: 0, 4: 0, 5: 0 } as Record<2 | 3 | 4 | 5, number>;
  for (const s of list) for (const l of [2, 3, 4, 5] as const) ups[l] += s.levelUpsMonth[l];
  const small = (vals: number[]) => vals.some((n) => n > 0 && n < SMALL);
  return {
    owners: list.length,
    pointsMonth: sum((s) => s.pointsMonth),
    points14: sum((s) => s.points14),
    ownersAwarded14: list.filter((s) => s.awarded14).length,
    reversals: sum((s) => s.reversals),
    byLevel: small(Object.values(byLevel)) ? null : byLevel,
    levelUpsMonth: small(Object.values(ups)) ? null : ups,
    levelUpsMonthTotal: Object.values(ups).reduce((a, b) => a + b, 0),
    bookedByType: {
      messages: Number(sum((s) => s.bookedByType.messages).toFixed(2)),
      trial_days: Number(sum((s) => s.bookedByType.trial_days).toFixed(2)),
      week: Number(sum((s) => s.bookedByType.week).toFixed(2)),
    },
    waiting: {
      ceiling: sum((s) => s.waiting.ceiling),
      not_paying: sum((s) => s.waiting.not_paying),
      flag_off: sum((s) => s.waiting.flag_off),
      paused: sum((s) => s.waiting.paused),
    },
    ceilingHitsMonth: sum((s) => s.ceilingHitsMonth),
    ceilingHitsLastMonth: sum((s) => s.ceilingHitsLastMonth),
    s2BurstTenants: list.filter((s) => s.s2Burst).length,
    s3Tiny: sum((s) => s.s3Tiny),
    records14: sum((s) => s.records14),
    s4SameAmount: sum((s) => s.s4SameAmount),
    s5LaterDelete: sum((s) => s.s5LaterDelete),
  };
}

// ---------------------------------------------------------------- invitaciones (§P4.9 filas 4–6)

export type ReferralStats = {
  /** Fila 4: por paso, en 90 días y en total (como quien invita). */
  signedUp90: number;
  active90: number;
  paid90: number;
  signedUpAll: number;
  activeAll: number;
  paidAll: number;
  ended: { expired: number; returning: number; reversed: number; refused: number };
  /** Fila 5: meses de regalo por estado; +50 del invitado (como invitado) y su costo. */
  months: { pending_review: number; waiting: number; applied: number; cancelled: number };
  inviteeBonus: number;
  inviteeBonusUsd: number;
  /** Fila 6: invitaciones con señales; código pausado. */
  flagged: number;
  codeDisabled: boolean;
};

export async function referralStats(tx: Tx, tenantId: string, now: Date): Promise<ReferralStats> {
  const since = new Date(now.getTime() - 90 * 86_400_000);
  const refs = rows<{
    stage: string;
    signed_up_at: string;
    active_at: string | null;
    paid_at: string | null;
    end_reason: string | null;
    flags: Record<string, boolean>;
    invitee_trashed: boolean;
  }>(await tx.execute(sql`select * from app.my_referrals()`));
  const grants = rows<{ kind: string; status: string; cost: string }>(
    await tx.execute(sql`
      select kind, status, cost_usd_estimate::text as cost from app.reward_grant
      where tenant_id = ${tenantId} and kind in ('ref_month', 'ref_invitee_msgs')`),
  );
  const [code] = rows<{ disabled: boolean }>(
    await tx.execute(sql`
      select disabled_at is not null as disabled from app.referral_code where tenant_id = ${tenantId}`),
  );
  const live = refs.filter((r) => !r.invitee_trashed && r.end_reason !== "returning");
  const recent = live.filter((r) => new Date(r.signed_up_at) >= since);
  const count = (list: typeof refs, f: (r: (typeof refs)[number]) => boolean) =>
    list.filter(f).length;
  const months = grants.filter((g) => g.kind === "ref_month");
  const bonus = grants.filter((g) => g.kind === "ref_invitee_msgs" && g.status === "applied");
  return {
    signedUp90: recent.length,
    active90: count(recent, (r) => Boolean(r.active_at)),
    paid90: count(recent, (r) => Boolean(r.paid_at)),
    signedUpAll: live.length,
    activeAll: count(live, (r) => Boolean(r.active_at)),
    paidAll: count(live, (r) => Boolean(r.paid_at)),
    ended: {
      expired: count(refs, (r) => r.end_reason === "expired"),
      returning: count(refs, (r) => r.end_reason === "returning"),
      reversed: count(refs, (r) => r.end_reason === "reversed"),
      refused: months.filter((g) => g.status === "refused").length,
    },
    months: {
      pending_review: months.filter((g) => g.status === "pending_review").length,
      waiting: months.filter((g) => g.status === "waiting").length,
      applied: months.filter((g) => g.status === "applied").length,
      cancelled: months.filter((g) => g.status === "cancelled").length,
    },
    inviteeBonus: bonus.length,
    inviteeBonusUsd: bonus.reduce((a, g) => a + Number(g.cost), 0),
    flagged: count(refs, (r) => Object.values(r.flags ?? {}).some(Boolean)),
    codeDisabled: code?.disabled === true,
  };
}

export type ReferralSummary = Omit<ReferralStats, "codeDisabled"> & {
  codesDisabled: number;
  /** Invitados por chat (aún sin cuenta), de `signup.data.ref` (P-4). */
  invitedChat: number;
};

export function summarizeReferrals(list: ReferralStats[], invitedChat: number): ReferralSummary {
  const sum = (f: (s: ReferralStats) => number) => list.reduce((n, s) => n + f(s), 0);
  return {
    signedUp90: sum((s) => s.signedUp90),
    active90: sum((s) => s.active90),
    paid90: sum((s) => s.paid90),
    signedUpAll: sum((s) => s.signedUpAll),
    activeAll: sum((s) => s.activeAll),
    paidAll: sum((s) => s.paidAll),
    ended: {
      expired: sum((s) => s.ended.expired),
      returning: sum((s) => s.ended.returning),
      reversed: sum((s) => s.ended.reversed),
      refused: sum((s) => s.ended.refused),
    },
    months: {
      pending_review: sum((s) => s.months.pending_review),
      waiting: sum((s) => s.months.waiting),
      applied: sum((s) => s.months.applied),
      cancelled: sum((s) => s.months.cancelled),
    },
    inviteeBonus: sum((s) => s.inviteeBonus),
    inviteeBonusUsd: Number(sum((s) => s.inviteeBonusUsd).toFixed(2)),
    flagged: sum((s) => s.flagged),
    codesDisabled: list.filter((s) => s.codeDisabled).length,
    invitedChat,
  };
}

/** Registros por chat que llegaron con un código válido y todavía no tienen cuenta (P-4). */
export async function invitedByChat(db: { execute: Tx["execute"] }): Promise<number> {
  const [r] = rows<{ n: number }>(
    await db.execute(sql`
      select count(*)::int as n from app.signup
      where completed_at is null and purged_at is null and data ? 'ref'`),
  );
  return r?.n ?? 0;
}
