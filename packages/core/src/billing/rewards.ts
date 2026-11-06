import { and, asc, eq, inArray, type Queryable, rows, schema, sql, type Tx } from "@caja/db";
import { addDays, businessDateOf, type IsoDate, lastDayOfMonth } from "../domain/dates";
import { Decimal } from "../domain/money";
import { addExtraMessages, setTenantBilling } from "./payments";
import { FOUNDER, planById } from "./plans";
import { withDiscount } from "./pricing";
import { subscriptionState } from "./subscription";
import { trialMessageCap, trialSpend } from "./trial";
import { caracasMonth } from "./usage";

/**
 * Regalos de los niveles (PRD hábitos v4.2.1, fase 4, §P4.6). Solo regalos de Rocco: mensajes,
 * días de prueba, días del plan y el descuento de Leyenda. Un tope de dólares por mes para todos
 * (`app_setting` `rewards`); lo reservado vive en `reward_month`, que solo se escribe con
 * `app.book_reward_cost` (SECURITY DEFINER, 0035). Nada de esto corre con `habits.xp` apagado.
 */

// ---------------------------------------------------------------- valores (config, no textos)

/** Puntos de cada regla (§P4.3). */
export const POINT_RULES = {
  record_day: 5,
  close_day: 2,
  signup_done: 20,
  panel_connected: 20,
  accounts_2: 15,
  first_budget: 20,
  first_reminder: 10,
  employee_joined: 15,
  ref_active: 50,
  ref_paid: 100,
} as const;
export type PointRule = keyof typeof POINT_RULES;
export const ONE_TIME_RULES = [
  "signup_done",
  "panel_connected",
  "accounts_2",
  "first_budget",
  "first_reminder",
  "employee_joined",
] as const satisfies readonly PointRule[];
export const DAILY_RULES = ["record_day", "close_day", "streak_bonus"] as const;

/** Bono de racha por hito: se repite cada 30 días (7, 15, 30, 37, 45, 60…). */
export const STREAK_BONUS: Record<number, number> = { 7: 25, 15: 50, 30: 100 };

export type Level = 1 | 2 | 3 | 4 | 5;
/** Umbrales de puntos totales (§P4.5). */
export const LEVEL_MIN: Record<Level, number> = { 1: 0, 2: 100, 3: 400, 4: 1200, 5: 3000 };
/** Nombres del fundador (D17). Siempre después de «nivel» en los textos. */
export const LEVEL_NAMES: Record<Level, string> = {
  1: "Cachorro",
  2: "Guardián",
  3: "Pana Fiel",
  4: "Oro",
  5: "Leyenda",
};
export const MAX_LEVEL: Level = 5;

/** Regalos (decisión 1A, A35). */
export const GIFTS = {
  msg2: 20,
  msg3: 50,
  dias3: 7,
  oroDays: 7,
  pct5: 10,
  /** Peor caso de un mensaje (IA + Meta), para reservar el tope (§P4.6). */
  msgCostUsd: 0.021,
  /** Pana Fiel en la prueba: 7 días de uso dentro del tope de 100 mensajes (§P4.6). */
  trialDaysCostUsd: 0.6,
  /** Leyenda termina a los 30 días suspendido sin un pago nuevo (D18). */
  leyendaGraceDays: 30,
} as const;

export const levelForTotal = (total: number): Level =>
  ([5, 4, 3, 2, 1] as const).find((l) => total >= LEVEL_MIN[l]) ?? 1;
export const levelKind = (l: Level) => `level_n${l}` as const;
export const kindLevel = (kind: string): Level | null => {
  const m = /^level_n([2-5])$/.exec(kind);
  return m ? (Number(m[1]) as Level) : null;
};

/** Cuentas del equipo (etiqueta CRM «interna», A41): suman puntos, sus regalos son de prueba. */
export const isInternalTenant = (t: { crmTags: string[] | null }) =>
  (t.crmTags ?? []).some((g) => g.trim().toLowerCase() === "interna");

// ---------------------------------------------------------------- ajustes (`app_setting` `rewards`)

export const MAX_CEILING_USD = 200;

export type RewardSettings = {
  /** Tope de regalos del mes, en US$ (0 = pausa, P-13). */
  monthlyCeilingUsd: number;
  /** Sin efecto en P4 (no hay columna de nombres, A43). Siempre false. */
  showInviteeNames: false;
  /** Desde qué día de Caracas suman los puntos diarios (A40): el día que se encendió `xp`. */
  xpOnSince: IsoDate | null;
  /** Primera vez que se encendió `referrals` (P-16: las líneas de invitación quedan en /puntos). */
  referralsOnSince: IsoDate | null;
  /** Días en que cambiaron `dailyClose` y `referrals` (la fecha de /puntos, P-16). */
  dailyCloseChangedOn: IsoDate | null;
  referralsChangedOn: IsoDate | null;
  /** Último mes ('YYYY-MM') cuya entrega del día 1 ya corrió (D19). */
  releasedMonth: string | null;
  /** Último día en que corrió la sincronización diaria de todos los negocios. */
  sweptOn: IsoDate | null;
  /** Alerta de /admin (A46): el mes con el que se pasó el tope dos meses seguidos. */
  alertMonth: string | null;
  alertDismissed: boolean;
};

export const REWARD_DEFAULTS: RewardSettings = {
  monthlyCeilingUsd: 20,
  showInviteeNames: false,
  xpOnSince: null,
  referralsOnSince: null,
  dailyCloseChangedOn: null,
  referralsChangedOn: null,
  releasedMonth: null,
  sweptOn: null,
  alertMonth: null,
  alertDismissed: false,
};
const KEY = "rewards";

/** Tope válido: de 0 a 200 con 2 decimales (SEC-P4-11); otra cosa → null. */
export function parseCeiling(v: unknown): number | null {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n >= 0 && n <= MAX_CEILING_USD ? n : null;
}
const isoOrNull = (v: unknown): IsoDate | null =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? (v as IsoDate) : null;
const monthOrNull = (v: unknown): string | null =>
  typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? v : null;

export async function rewardSettings(db: Queryable): Promise<RewardSettings> {
  const [r] = await db
    .select({ value: schema.appSetting.value })
    .from(schema.appSetting)
    .where(eq(schema.appSetting.key, KEY));
  const v = (r?.value ?? {}) as Record<string, unknown>;
  return {
    monthlyCeilingUsd: parseCeiling(v.monthlyCeilingUsd) ?? REWARD_DEFAULTS.monthlyCeilingUsd,
    showInviteeNames: false,
    xpOnSince: isoOrNull(v.xpOnSince),
    referralsOnSince: isoOrNull(v.referralsOnSince),
    dailyCloseChangedOn: isoOrNull(v.dailyCloseChangedOn),
    referralsChangedOn: isoOrNull(v.referralsChangedOn),
    releasedMonth: monthOrNull(v.releasedMonth),
    sweptOn: isoOrNull(v.sweptOn),
    alertMonth: monthOrNull(v.alertMonth),
    alertDismissed: v.alertDismissed === true,
  };
}

/** Guarda solo lo que cambia, junto a lo que ya hubiera. El tope se valida (0 a 200). */
export async function saveRewardSettings(
  db: Queryable,
  next: Partial<RewardSettings>,
  actor: string,
  now: Date,
): Promise<RewardSettings> {
  if (next.monthlyCeilingUsd !== undefined && parseCeiling(next.monthlyCeilingUsd) === null)
    throw new Error("tope inválido");
  const current = await rewardSettings(db);
  const value: RewardSettings = { ...current, ...next, showInviteeNames: false as const };
  await db
    .insert(schema.appSetting)
    .values({ key: KEY, value, updatedAt: now, updatedBy: actor })
    .onConflictDoUpdate({
      target: schema.appSetting.key,
      set: { value, updatedAt: now, updatedBy: actor },
    });
  return value;
}

/**
 * Lo que cambia en `rewards` cuando /admin guarda los interruptores: el día de encendido de `xp`
 * (A40, sin puntos de días anteriores) y los días en que cambiaron `dailyClose` y `referrals`
 * (la fecha de /puntos, P-16).
 */
export function rewardChangesForFlags(
  before: { xp: boolean; dailyClose: boolean; referrals: boolean },
  after: { xp: boolean; dailyClose: boolean; referrals: boolean },
  current: RewardSettings,
  now: Date,
): Partial<RewardSettings> {
  const today = businessDateOf(now);
  const out: Partial<RewardSettings> = {};
  if (after.xp && !before.xp) out.xpOnSince = today;
  if (after.dailyClose !== before.dailyClose) out.dailyCloseChangedOn = today;
  if (after.referrals !== before.referrals) out.referralsChangedOn = today;
  if (after.referrals && !current.referralsOnSince) out.referralsOnSince = today;
  return out;
}

// ---------------------------------------------------------------- el tope del mes

/** Reserva `usd` del mes en el contador común (0035). false = no cabe bajo el tope. */
export async function bookRewardCost(
  tx: Tx,
  month: string,
  usd: Decimal,
  force: boolean,
): Promise<boolean> {
  const [r] = rows<{ ok: boolean }>(
    await tx.execute(
      sql`select app.book_reward_cost(${month}, ${usd.toFixed(2)}::numeric, ${force}) as ok`,
    ),
  );
  return r?.ok === true;
}

export async function bookedThisMonth(db: Queryable, month: string): Promise<Decimal> {
  const [r] = await db
    .select({ booked: schema.rewardMonth.bookedUsd })
    .from(schema.rewardMonth)
    .where(eq(schema.rewardMonth.month, month));
  return new Decimal(r?.booked ?? 0);
}

const nextMonthFirst = (today: IsoDate): IsoDate => addDays(lastDayOfMonth(today), 1);

// ---------------------------------------------------------------- aplicar un regalo

type TenantRow = typeof schema.tenant.$inferSelect;
type Grant = typeof schema.rewardGrant.$inferSelect;
export type WaitReason = "ceiling" | "not_paying" | "flag_off" | "paused";

/** Lo que trae un regalo para este negocio hoy. */
type Benefit =
  | { kind: "messages"; k: number }
  | { kind: "trial_days"; days: number }
  | { kind: "week" }
  | { kind: "discount" }
  | { kind: "not_paying" };

/** Datos de la línea para el dueño (RW2 / RW8): solo valores, el texto lo pone `render`. */
export type GiftLine = {
  level: Level;
  /** `applied` (o `test`), o por qué espera. */
  outcome: "applied" | WaitReason;
  benefit: Benefit["kind"];
  k?: number;
  days?: number;
  trial?: boolean;
  /** Tope de mensajes de la prueba después del regalo. */
  tope?: number;
  /** Último día para usar los mensajes de un plan pagado (fin del mes de Caracas). */
  vence?: IsoDate;
  /** Nuevo fin de la prueba o del plan. */
  fin?: IsoDate;
  /** Día en que llega un regalo detenido por el tope (el 1 del mes siguiente, D19). */
  fechaTope?: IsoDate;
};

export type SettleCtx = {
  now: Date;
  rewardsOn: boolean;
  ceilingUsd: number;
  /** Entrega del día 1 (D19) y Leyenda: reserva sin mirar el tope. */
  force?: boolean;
};

const DAY_MS = 86_400_000;

/** Igual que `founderDiscount` (renew.ts), aquí para no importar en círculo. */
const founderPct = (t: { founderUntil: string | null }, now: Date) =>
  t.founderUntil && businessDateOf(now) <= t.founderUntil ? FOUNDER.discountPct : 0;

export function isPaying(t: TenantRow, now: Date): boolean {
  if (t.status === "trial" || !t.paidUntil) return false;
  const k = subscriptionState(t, now).kind;
  return k === "active" || k === "grace";
}

async function benefitFor(
  tx: Tx,
  t: TenantRow,
  level: Level,
  now: Date,
  heldBefore: boolean,
): Promise<Benefit> {
  if (level === 2) return { kind: "messages", k: GIFTS.msg2 };
  if (level === 5) return { kind: "discount" };
  if (level === 4) return isPaying(t, now) ? { kind: "week" } : { kind: "not_paying" };
  // Pana Fiel: días de prueba si la prueba no llegó a su tope (§P4.4 regla 11); con el tope,
  // espera al primer pago (A48). Detenido por el tope de regalos, llega como mensajes (RW2).
  if (t.status !== "trial") return { kind: "messages", k: GIFTS.msg3 };
  const spend = await trialSpend(tx, t);
  if (spend.reached) return { kind: "not_paying" };
  return heldBefore
    ? { kind: "messages", k: GIFTS.msg3 }
    : { kind: "trial_days", days: GIFTS.dias3 };
}

function costOf(t: TenantRow, b: Benefit, now: Date): Decimal {
  if (b.kind === "messages") return new Decimal(GIFTS.msgCostUsd).mul(b.k).toDecimalPlaces(2);
  if (b.kind === "trial_days") return new Decimal(GIFTS.trialDaysCostUsd);
  if (b.kind === "week") {
    const month = withDiscount(new Decimal(planById(t.plan).priceUsd), founderPct(t, now));
    return month.mul(GIFTS.oroDays).div(30).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }
  return new Decimal(0);
}

/**
 * Decide y aplica un regalo que está `waiting` (recién creado o detenido). El cambio de estado va
 * primero y con guarda (`WHERE status = 'waiting' RETURNING`): dos corridas a la vez lo aplican una
 * sola vez (SEC-P4-9 b). Orden (§P4.6): cuenta interna → `rewards` apagado → no paga → tope.
 */
export async function settleGrant(
  tx: Tx,
  grantId: string,
  ctx: SettleCtx,
): Promise<{ grant: Grant; line: GiftLine } | null> {
  const [claimed] = await tx
    .update(schema.rewardGrant)
    .set({ updatedAt: ctx.now })
    .where(and(eq(schema.rewardGrant.id, grantId), eq(schema.rewardGrant.status, "waiting")))
    .returning();
  if (!claimed) return null;
  const level = kindLevel(claimed.kind);
  if (!level) return null;
  const [t] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, claimed.tenantId));
  if (!t) return null;
  const today = businessDateOf(ctx.now);
  const heldBefore =
    claimed.waitReason === "ceiling" ||
    claimed.waitReason === "paused" ||
    claimed.waitReason === "flag_off";
  const benefit = await benefitFor(tx, t, level, ctx.now, heldBefore);
  const base: GiftLine = {
    level,
    outcome: "applied",
    benefit: benefit.kind,
    trial: t.status === "trial",
    ...(benefit.kind === "messages" ? { k: benefit.k } : {}),
    ...(benefit.kind === "trial_days" ? { days: benefit.days } : {}),
  };
  const wait = async (reason: WaitReason, extra: Record<string, unknown> = {}) => {
    const [g] = await tx
      .update(schema.rewardGrant)
      .set({
        waitReason: reason,
        flags: { ...(claimed.flags as Record<string, unknown>), ...extra },
        updatedAt: ctx.now,
      })
      .where(eq(schema.rewardGrant.id, claimed.id))
      .returning();
    const line: GiftLine = {
      ...base,
      outcome: reason,
      ...(reason === "ceiling" ? { fechaTope: nextMonthFirst(today) } : {}),
      // Detenido por el tope, Pana Fiel llega como mensajes (RW2).
      ...(reason === "ceiling" && level === 3
        ? { benefit: "messages" as const, k: GIFTS.msg3 }
        : {}),
      ...(reason === "not_paying" && level === 3 ? { k: GIFTS.msg3 } : {}),
    };
    return { grant: g ?? claimed, line };
  };

  // A41: cuentas internas, de prueba, sin efecto en el cobro ni en el tope.
  if (isInternalTenant(t)) {
    const [g] = await tx
      .update(schema.rewardGrant)
      .set({
        status: "test",
        waitReason: null,
        appliedAs: benefit.kind,
        appliedAt: ctx.now,
        updatedAt: ctx.now,
      })
      .where(eq(schema.rewardGrant.id, claimed.id))
      .returning();
    return { grant: g ?? claimed, line: describe(t, base, ctx.now) };
  }
  if (!ctx.rewardsOn) return wait("flag_off");
  if (benefit.kind === "not_paying") return wait("not_paying");

  const cost = costOf(t, benefit, ctx.now);
  const month = caracasMonth(ctx.now).key;
  let booked: string | null = null;
  if (benefit.kind !== "discount" && cost.gt(0)) {
    if (!ctx.force && ctx.ceilingUsd <= 0) return wait("paused");
    if (!(await bookRewardCost(tx, month, cost, ctx.force === true)))
      return wait("ceiling", { ceilingHitMonth: month });
    booked = month;
  }
  // Efecto en el cobro, con auditoría de sistema (§P4.12 item 10).
  let after = t;
  if (benefit.kind === "messages") {
    await addExtraMessages(tx, t, benefit.k, null, ctx.now, "reward");
  } else if (benefit.kind === "trial_days" && t.trialEndsAt) {
    await setTenantBilling(
      tx,
      t,
      { trialEndsAt: new Date(t.trialEndsAt.getTime() + benefit.days * DAY_MS) },
      null,
      ctx.now,
      "reward_trial_days",
    );
  } else if (benefit.kind === "week" && t.paidUntil) {
    await setTenantBilling(
      tx,
      t,
      { paidUntil: new Date(t.paidUntil.getTime() + GIFTS.oroDays * DAY_MS) },
      null,
      ctx.now,
      "reward_free_week",
    );
  }
  const [fresh] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, t.id));
  if (fresh) after = fresh;
  const [g] = await tx
    .update(schema.rewardGrant)
    .set({
      status: "applied",
      waitReason: null,
      appliedAs: benefit.kind,
      appliedAt: ctx.now,
      costUsdEstimate: cost.toFixed(2),
      bookedMonth: booked,
      updatedAt: ctx.now,
    })
    .where(eq(schema.rewardGrant.id, claimed.id))
    .returning();
  return { grant: g ?? claimed, line: describe(after, base, ctx.now) };
}

/** Completa la línea con las fechas y el tope del negocio ya con el regalo. */
function describe(t: TenantRow, line: GiftLine, now: Date): GiftLine {
  const today = businessDateOf(now);
  if (line.benefit === "messages") {
    return line.trial
      ? { ...line, tope: trialMessageCap(t) }
      : { ...line, vence: lastDayOfMonth(today) };
  }
  if (line.benefit === "trial_days" && t.trialEndsAt)
    return {
      ...line,
      fin: businessDateOf(t.trialEndsAt),
      tope: trialMessageCap(t),
    };
  if (line.benefit === "week" && t.paidUntil) return { ...line, fin: businessDateOf(t.paidUntil) };
  return line;
}

// ---------------------------------------------------------------- líneas pendientes (RW2, RW8)

export type NoticeKind =
  /** RW2 / RW2-hold: subió de nivel. */
  | "level"
  /** RW8a-msgs / RW8a-week (al pagar), RW8b (detenido por el tope), RW8b-arrive (llegó). */
  | "gift_paid"
  | "gift_held"
  | "gift_arrived"
  /** RW8a-ley: el 10 % de Leyenda en este pago. */
  | "leyenda_paid"
  /** RW8h: puntos quitados a mano. */
  | "points_removed"
  /** P4-B: RW8c-first, RW8c-paid, RW8c-paid-trial, RW8d, RW8e, RW8f, RW8g, RW8a-ref. */
  | "ref_active"
  | "ref_paid"
  | "ref_paid_wait"
  | "ref_capped"
  | "ref_refused"
  | "ref_reversed"
  | "code_paused"
  | "ref_month_paid";

export async function addNotice(
  tx: Tx,
  tenantId: string,
  kind: NoticeKind,
  args: Record<string, unknown>,
  now: Date,
): Promise<void> {
  await tx
    .insert(schema.pointsNotice)
    .values({ tenantId, kind, args: JSON.parse(JSON.stringify(args)), createdAt: now });
}

// ---------------------------------------------------------------- liberar los detenidos

/** Los regalos que esperan en este negocio, del más viejo al más nuevo. */
export async function waitingGrants(
  tx: Tx,
  tenantId: string,
  reasons: WaitReason[],
): Promise<Grant[]> {
  return tx
    .select()
    .from(schema.rewardGrant)
    .where(
      and(
        eq(schema.rewardGrant.tenantId, tenantId),
        eq(schema.rewardGrant.status, "waiting"),
        inArray(schema.rewardGrant.waitReason, reasons),
      ),
    )
    .orderBy(asc(schema.rewardGrant.createdAt));
}

/**
 * Suelta los regalos de un negocio que esperaban por `rewards` apagado o por la pausa (tope en 0),
 * bajo el tope, del más viejo al más nuevo (§P4.6 reglas 6 y 8). Si vuelven a esperar por el tope,
 * la línea ya dicha (RW2-hold) sigue valiendo; al llegar, RW8b-arrive.
 */
export async function releaseHeldGrants(
  tx: Tx,
  tenantId: string,
  ctx: Omit<SettleCtx, "force">,
): Promise<number> {
  if (!ctx.rewardsOn || ctx.ceilingUsd <= 0) return 0;
  let n = 0;
  for (const g of await waitingGrants(tx, tenantId, ["flag_off", "paused"])) {
    const r = await settleGrant(tx, g.id, ctx);
    if (r && (r.grant.status === "applied" || r.grant.status === "test")) {
      n += 1;
      await addNotice(tx, tenantId, "gift_arrived", r.line, ctx.now);
    }
  }
  return n;
}

/**
 * Entrega del día 1 (D19, P-10): todo regalo detenido por el tope se aplica y se reserva en el mes
 * nuevo aunque pase el tope. Oro de un dueño que ya no paga pasa a `not_paying` sin reservar (P-14).
 * Las pausas (tope en 0, P-13) no salen aquí.
 */
export async function releaseCeilingGrants(
  tx: Tx,
  grantIds: string[],
  ctx: Omit<SettleCtx, "force">,
): Promise<number> {
  let n = 0;
  for (const id of grantIds) {
    const r = await settleGrant(tx, id, { ...ctx, force: true });
    if (r && r.grant.status === "applied") {
      n += 1;
      await addNotice(tx, r.grant.tenantId, "gift_arrived", r.line, ctx.now);
    }
  }
  return n;
}

/**
 * Al aprobar un pago de plan (hook de `approvePayment`): los regalos que esperaban un pago (Oro y
 * Pana Fiel con la prueba en su tope) se aplican encima de la vigencia nueva; si el mes ya no tiene
 * espacio, esperan al día 1 (RW8b). Leyenda: si el pago lleva el 10 %, se reserva su costo sin
 * mirar el tope (§P4.6 item 4). Las líneas van con el aviso de pago verificado (RW8a).
 */
export async function onPlanPaymentApproved(
  tx: Tx,
  tenantId: string,
  paymentId: string,
  now: Date,
  opts: { xpOn: boolean; rewardsOn: boolean; ceilingUsd: number; leyendaPct: number },
): Promise<void> {
  if (!opts.xpOn) return;
  const ctx = { now, rewardsOn: opts.rewardsOn, ceilingUsd: opts.ceilingUsd };
  for (const g of await waitingGrants(tx, tenantId, ["not_paying"])) {
    const r = await settleGrant(tx, g.id, ctx);
    if (!r) continue;
    if (r.grant.status === "applied")
      await addNotice(tx, tenantId, "gift_paid", { ...r.line, paymentId }, now);
    else if (r.grant.waitReason === "ceiling")
      await addNotice(tx, tenantId, "gift_held", r.line, now);
  }
  const [pay] = await tx.select().from(schema.payment).where(eq(schema.payment.id, paymentId));
  const [t] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId));
  if (!pay || !t || pay.kind !== "plan") return;
  // El 10 % se mira con el negocio de antes del pago (suspendido o no): lo calcula `approvePayment`.
  const pct = opts.leyendaPct;
  if (!pct || isInternalTenant(t)) return;
  // Costo del 10 %: lo que habría pagado con el precio fundador menos lo que paga con los dos.
  const plan = planById(pay.plan);
  const before = withDiscount(new Decimal(plan.priceUsd).mul(pay.months), founderPct(t, now));
  const cost = before.minus(withDiscount(before, pct));
  if (cost.gt(0)) await bookRewardCost(tx, caracasMonth(now).key, cost, true);
  await addNotice(tx, tenantId, "leyenda_paid", { level: 5, pct, paymentId }, now);
}

// ---------------------------------------------------------------- Leyenda (US-417, D18)

/**
 * El 10 % de Leyenda vale para este negocio (A45, D18): nivel 5 con su regalo aplicado y sin haber
 * pasado más de 30 días suspendido sin pagar. `reportedAt`: un pago reportado antes de ese límite
 * cuenta aunque se apruebe después (y al aprobarlo, `approving`, el 10 % sigue para los próximos).
 * Pasado el límite sin un pago a tiempo, queda terminado para siempre (`flags.endedAt`).
 */
export async function leyendaPct(
  tx: Tx,
  t: TenantRow,
  now: Date,
  opts: { reportedAt?: Date; approving?: boolean } = {},
): Promise<number> {
  if (t.pointsLevel < 5) return 0;
  const [g] = await tx
    .select()
    .from(schema.rewardGrant)
    .where(
      and(
        eq(schema.rewardGrant.tenantId, t.id),
        eq(schema.rewardGrant.kind, "level_n5"),
        eq(schema.rewardGrant.status, "applied"),
      ),
    );
  if (!g) return 0;
  const flags = g.flags as { endedAt?: string };
  const at = (opts.reportedAt ?? now).getTime();
  const setEnded = (endedAt: string | undefined) =>
    tx
      .update(schema.rewardGrant)
      .set({ flags: { ...flags, endedAt }, updatedAt: now })
      .where(eq(schema.rewardGrant.id, g.id));
  if (flags.endedAt) {
    if (at >= new Date(flags.endedAt).getTime()) return 0;
    // Pagó a tiempo (reportado antes del límite): el 10 % sigue.
    if (opts.approving) await setEnded(undefined);
    return GIFTS.pct5;
  }
  if (t.status === "suspended" && t.suspendedAt) {
    const limit = t.suspendedAt.getTime() + GIFTS.leyendaGraceDays * DAY_MS;
    if (now.getTime() > limit) {
      if (at < limit) {
        if (!opts.approving) await setEnded(new Date(limit).toISOString());
        return GIFTS.pct5;
      }
      await setEnded(new Date(limit).toISOString());
      return 0;
    }
  }
  return GIFTS.pct5;
}

/** ¿Terminó el 10 % de Leyenda (para la línea de RW4 / «Mis logros»)? */
export async function leyendaEnded(tx: Tx, tenantId: string): Promise<boolean> {
  const [g] = await tx
    .select({ flags: schema.rewardGrant.flags })
    .from(schema.rewardGrant)
    .where(and(eq(schema.rewardGrant.tenantId, tenantId), eq(schema.rewardGrant.kind, "level_n5")));
  return Boolean((g?.flags as { endedAt?: string } | undefined)?.endedAt);
}

// ---------------------------------------------------------------- alerta del tope (A46)

/** El mes anterior a 'YYYY-MM'. */
export function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/**
 * ¿Los dos meses antes de `month` cerraron con lo reservado por encima del tope (A46)? Entonces
 * /admin muestra la línea roja y `pnpm metrics` la imprime.
 */
export async function overCeilingTwoMonths(
  db: Queryable,
  month: string,
  ceilingUsd: number,
): Promise<boolean> {
  const a = prevMonth(month);
  const b = prevMonth(a);
  const [ba, bb] = await Promise.all([bookedThisMonth(db, a), bookedThisMonth(db, b)]);
  return ba.gt(ceilingUsd) && bb.gt(ceilingUsd);
}
