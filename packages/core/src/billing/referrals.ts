import { randomInt } from "node:crypto";
import { and, eq, gte, inArray, rows, schema, sql, type Tx } from "@caja/db";
import { businessDateOf, type IsoDate } from "../domain/dates";
import { Decimal } from "../domain/money";
import { keptDays } from "../ledger/habits";
import { addExtraMessages, setTenantBilling } from "./payments";
import { FOUNDER, PERIOD_DAYS, planById } from "./plans";
import { withDiscount } from "./pricing";
import { addNotice, bookRewardCost, isInternalTenant, isPaying, POINT_RULES } from "./rewards";
import { trialSpend } from "./trial";
import { caracasMonth } from "./usage";

/**
 * Invitaciones (PRD hábitos v4.2.1, fase 4, P4-B: US-418…US-423). El lado del invitado se escribe
 * solo con las funciones SECURITY DEFINER de 0036, que leen `app.tenant_id`; el lado del que
 * invita (puntos, regalos, avisos, pausar el código) solo con `inviterSweep`, dentro de
 * `withTenant(quien invita)`, desde las filas `referral` que lee (SEC-P4-8). Ninguna herramienta
 * del agente llega aquí (SEC-P4-14). Sin nombres, números ni montos del invitado (A43).
 */

export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

export const REFERRAL = {
  inviteeMsgs: 50,
  inviteeCostUsd: 1.05,
  monthsCap: 6,
  activeCap: 10,
  reviewDays: 7,
  lateDays: 7,
  lateAttempts: 3,
  /** Un mes de regalo (§P4.7): `paid_until` + 30 días. */
  monthDays: PERIOD_DAYS,
} as const;

/** ¿Tiene la forma de §P4.7 (6 del alfabeto, al menos 2 dígitos)? */
export function isCodeShape(code: string): boolean {
  return CODE_RE.test(code) && (code.match(/[0-9]/g)?.length ?? 0) >= 2;
}

/** Un código nuevo al azar con la forma de §P4.7. */
export function newCode(rand: (n: number) => number = randomInt): string {
  for (;;) {
    const c = Array.from({ length: 6 }, () => CODE_ALPHABET[rand(CODE_ALPHABET.length)]).join("");
    if (isCodeShape(c)) return c;
  }
}

const norm = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();

/**
 * El código de un mensaje (§P4.7): «me invitó CODE» o «código CODE» (hasta 3 palabras después),
 * o el código solo, si `alone` vale. Solo la forma: si existe lo dice `codeCheck`.
 */
export function parseInviteCode(text: string, opts: { alone: boolean }): string | null {
  const tokens = norm(text)
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  if (opts.alone && tokens.length === 1 && isCodeShape(tokens[0] as string))
    return tokens[0] as string;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const start = t === "INVITO" && tokens[i - 1] === "ME" ? i : t === "CODIGO" ? i : -1;
    if (start < 0) continue;
    for (const c of tokens.slice(start + 1, start + 4)) if (isCodeShape(c)) return c;
  }
  return null;
}

/** «me invitó CODE» después del registro (RW-late): la frase con un código con la forma. */
export const isLateCodeAsk = (text: string) =>
  text.length <= 80 && /\bME INVITO\b/.test(norm(text)) && parseInviteCode(text, { alone: false });

export type CodeCheck = "none" | "not_eligible" | "ok";

/** Lo mínimo de un código (0036): nunca el negocio que lo tiene (SEC-P4-8). */
export async function codeCheck(tx: Tx, code: string): Promise<CodeCheck> {
  if (!isCodeShape(code)) return "none";
  const [r] = rows<{ v: CodeCheck }>(
    await tx.execute(sql`select app.referral_code_check(${code}) as v`),
  );
  return r?.v ?? "none";
}

export type AttachResult = "attached" | "returning" | "invalid" | "not_found" | "already";

/** Une el negocio actual (invitado) con el código (0036, `app.attach_referral`). */
export async function attachReferral(
  tx: Tx,
  code: string,
  via: "web" | "chat" | "late",
): Promise<AttachResult> {
  const [r] = rows<{ v: AttachResult }>(
    await tx.execute(sql`select app.attach_referral(${code}, ${via}) as v`),
  );
  return r?.v ?? "not_found";
}

/** Mueve el paso de la invitación del negocio actual como invitado (0036). */
export async function syncInvitee(tx: Tx): Promise<void> {
  await tx.execute(sql`select app.referral_sync_invitee()`);
}

// ---------------------------------------------------------------- quien invita

type TenantRow = typeof schema.tenant.$inferSelect;

/** ¿Puede invitar? (§P4.4 regla 10, P-3): dueño activo con 3 días con registro y código habilitado. */
export async function canInvite(tx: Tx, t: TenantRow): Promise<boolean> {
  if (t.deletedAt || t.status === "suspended") return false;
  const kept = await keptDays(tx, t.id);
  if ([...kept.values()].filter((s) => s === "recorded").length < 3) return false;
  const [c] = await tx
    .select({ disabledAt: schema.referralCode.disabledAt })
    .from(schema.referralCode)
    .where(eq(schema.referralCode.tenantId, t.id));
  return !c?.disabledAt;
}

/** El código del dueño, creado la primera vez (US-419). null si no puede invitar. */
export async function referralCodeFor(tx: Tx, tenantId: string): Promise<string | null> {
  const [t] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId));
  if (!t || !(await canInvite(tx, t))) return null;
  const [own] = await tx
    .select({ code: schema.referralCode.code })
    .from(schema.referralCode)
    .where(eq(schema.referralCode.tenantId, tenantId));
  if (own) return own.code;
  for (let i = 0; i < 8; i++) {
    const code = newCode();
    const done = await tx
      .insert(schema.referralCode)
      .values({ tenantId, code })
      .onConflictDoNothing()
      .returning({ code: schema.referralCode.code });
    if (done[0]) return done[0].code;
    // Otro pedido del mismo negocio pudo crearlo a la vez.
    const [again] = await tx
      .select({ code: schema.referralCode.code })
      .from(schema.referralCode)
      .where(eq(schema.referralCode.tenantId, tenantId));
    if (again) return again.code;
  }
  throw new Error("referral_code: sin código libre");
}

export type MyReferral = {
  id: string;
  inviteeTenantId: string;
  via: string;
  stage: "signed_up" | "active" | "paid" | "ended";
  signedUpAt: Date;
  activeAt: Date | null;
  paidAt: Date | null;
  paymentId: string | null;
  sourceApprovedAt: Date | null;
  endedAt: Date | null;
  endReason: string | null;
  flags: Record<string, boolean>;
  inviteeTrashed: boolean;
};

/** Las invitaciones del negocio actual, con si el invitado está en la papelera (0036). */
export async function myReferrals(tx: Tx): Promise<MyReferral[]> {
  const found = rows<Record<string, unknown>>(
    await tx.execute(sql`select * from app.my_referrals()`),
  );
  const at = (v: unknown) => (v ? new Date(v as string) : null);
  return found.map((r) => ({
    id: r.id as string,
    inviteeTenantId: r.invitee_tenant_id as string,
    via: r.via as string,
    stage: r.stage as MyReferral["stage"],
    signedUpAt: new Date(r.signed_up_at as string),
    activeAt: at(r.active_at),
    paidAt: at(r.paid_at),
    paymentId: (r.payment_id as string | null) ?? null,
    sourceApprovedAt: at(r.source_approved_at),
    endedAt: at(r.ended_at),
    endReason: (r.end_reason as string | null) ?? null,
    flags: (r.flags ?? {}) as Record<string, boolean>,
    inviteeTrashed: r.invitee_trashed === true,
  }));
}

const YEAR_MS = 365 * 86_400_000;

/**
 * Meses de regalo en los últimos 12 meses (P-15): por fecha de creación, en revisión, esperando o
 * aplicados (también si la invitación se devolvió después); no los rechazados ni cancelados.
 * `resetOn`: el día en que el más viejo de los últimos 6 cumple 12 meses (RW8d, RW5-5).
 */
export async function monthsInLast12(
  tx: Tx,
  tenantId: string,
  now: Date,
): Promise<{ k: number; resetOn: IsoDate | null }> {
  const grants = await tx
    .select({ createdAt: schema.rewardGrant.createdAt })
    .from(schema.rewardGrant)
    .where(
      and(
        eq(schema.rewardGrant.tenantId, tenantId),
        eq(schema.rewardGrant.kind, "ref_month"),
        inArray(schema.rewardGrant.status, ["pending_review", "waiting", "applied"]),
        gte(schema.rewardGrant.createdAt, new Date(now.getTime() - YEAR_MS)),
      ),
    );
  const dates = grants.map((g) => g.createdAt.getTime()).sort((a, b) => b - a);
  const last6 = dates.slice(0, REFERRAL.monthsCap);
  const oldest = last6[last6.length - 1];
  return {
    k: dates.length,
    resetOn:
      dates.length >= REFERRAL.monthsCap && oldest
        ? businessDateOf(new Date(oldest + YEAR_MS))
        : null,
  };
}

async function award(
  tx: Tx,
  tenantId: string,
  rule: string,
  refKey: string,
  points: number,
  now: Date,
  extra: { reason?: string; reverses?: string } = {},
): Promise<boolean> {
  const done = await tx
    .insert(schema.pointsEvent)
    .values({
      tenantId,
      rule,
      refKey,
      points,
      businessDate: businessDateOf(now),
      reason: extra.reason ?? null,
      reverses: extra.reverses ?? null,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.pointsEvent.id });
  return done.length > 0;
}

const DAY_MS = 86_400_000;

/**
 * El lado del que invita (US-422), dentro de `withTenant(quien invita)`, desde sus filas
 * `referral`: +50 al primer día con registro del invitado (máx. 10 en 12 meses), +100 y el mes de
 * regalo en revisión cuando paga (máx. 6 en 12 meses; el 7.º, nada y RW8d), y la devolución del
 * pago (§P4.4 regla 8: antes de aplicar el mes, se cancela y −100 con RW8f; después, nada; dos
 * devoluciones pausan el código con RW8g). Nada se mueve con el invitado en la papelera (PV-1).
 * Devuelve cuántas cosas hizo.
 */
export async function inviterSweep(tx: Tx, tenantId: string, now: Date): Promise<number> {
  let n = 0;
  const list = await myReferrals(tx);
  if (list.length === 0) return 0;
  const grants = await tx
    .select()
    .from(schema.rewardGrant)
    .where(
      and(eq(schema.rewardGrant.tenantId, tenantId), eq(schema.rewardGrant.kind, "ref_month")),
    );
  for (const r of list) {
    if (r.inviteeTrashed || r.endReason === "returning") continue;
    if (r.activeAt) {
      const actives =
        rows<{ n: number }>(
          await tx.execute(sql`
          select count(*)::int as n from app.points_event
          where tenant_id = ${tenantId} and rule = 'ref_active' and points > 0
            and created_at > ${new Date(now.getTime() - YEAR_MS)}`),
        )[0]?.n ?? 0;
      const capped = actives >= REFERRAL.activeCap;
      if (await award(tx, tenantId, "ref_active", r.id, capped ? 0 : POINT_RULES.ref_active, now)) {
        n += 1;
        if (!capped)
          await addNotice(tx, tenantId, "ref_active", { k: POINT_RULES.ref_active }, now);
      }
    }
    const grant = grants.find((g) => g.referralId === r.id);
    if (r.paidAt && !grant && r.endReason !== "reversed") {
      const months = await monthsInLast12(tx, tenantId, now);
      if (months.k >= REFERRAL.monthsCap) {
        // A47, P-15: el 7.º no suma mes ni puntos. Queda la marca para no volver a mirarlo.
        const done = await tx
          .insert(schema.rewardGrant)
          .values({
            tenantId,
            kind: "ref_month",
            status: "cancelled",
            referralId: r.id,
            flags: { capped: true },
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: schema.rewardGrant.id });
        if (done[0]) {
          n += 1;
          await addNotice(tx, tenantId, "ref_capped", { resetOn: months.resetOn }, now);
        }
      } else {
        const [t] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId));
        const done = await tx
          .insert(schema.rewardGrant)
          .values({
            tenantId,
            kind: "ref_month",
            status: isInternalTenant(t ?? { crmTags: [] }) ? "test" : "pending_review",
            referralId: r.id,
            paymentId: r.paymentId,
            sourceApprovedAt: r.sourceApprovedAt,
            costUsdEstimate: t ? monthCost(t, now).toFixed(2) : "0",
            flags: { ...r.flags },
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: schema.rewardGrant.id });
        if (done[0]) {
          n += 1;
          await award(tx, tenantId, "ref_paid", r.id, POINT_RULES.ref_paid, now);
        }
      }
    }
    if (
      r.endReason === "reversed" &&
      grant &&
      !(grant.flags as { reversedAt?: string }).reversedAt
    ) {
      n += 1;
      const before = grant.status === "pending_review" || grant.status === "waiting";
      const [g] = await tx
        .update(schema.rewardGrant)
        .set({
          ...(before ? { status: "cancelled", waitReason: null } : {}),
          flags: { ...(grant.flags as object), reversedAt: now.toISOString() },
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.rewardGrant.id, grant.id),
            sql`not (${schema.rewardGrant.flags} ? 'reversedAt')`,
          ),
        )
        .returning();
      if (g && before) {
        // F-1: RW8f solo si el mes no se había aplicado; quitar el +100 de esa invitación.
        const [paid] = await tx
          .select({ id: schema.pointsEvent.id })
          .from(schema.pointsEvent)
          .where(
            and(
              eq(schema.pointsEvent.tenantId, tenantId),
              eq(schema.pointsEvent.rule, "ref_paid"),
              eq(schema.pointsEvent.refKey, r.id),
            ),
          );
        if (paid)
          await award(tx, tenantId, "ref_paid", `${r.id}:rev`, -POINT_RULES.ref_paid, now, {
            reason: "ref_reversed",
            reverses: paid.id,
          });
        await addNotice(tx, tenantId, "ref_reversed", { k: POINT_RULES.ref_paid }, now);
      }
    }
  }
  // Dos invitaciones que dejaron de contar → código pausado, una vez (RW8g).
  const reversedCount = (
    await tx
      .select({ flags: schema.rewardGrant.flags })
      .from(schema.rewardGrant)
      .where(
        and(eq(schema.rewardGrant.tenantId, tenantId), eq(schema.rewardGrant.kind, "ref_month")),
      )
  ).filter((g) => (g.flags as { reversedAt?: string }).reversedAt).length;
  if (reversedCount >= 2) {
    const paused = await tx
      .update(schema.referralCode)
      .set({ disabledAt: now, disabledReason: "reversals" })
      .where(
        and(
          eq(schema.referralCode.tenantId, tenantId),
          sql`${schema.referralCode.disabledAt} is null`,
          sql`${schema.referralCode.disabledReason} is distinct from 'reversals'`,
        ),
      )
      .returning({ id: schema.referralCode.id });
    if (paused[0]) {
      n += 1;
      await addNotice(tx, tenantId, "code_paused", {}, now);
    }
  }
  return n;
}

/** Lo que vale un mes del plan de quien invita, con su precio fundador (§P4.7 item 5). */
function monthCost(t: TenantRow, now: Date): Decimal {
  const pct = t.founderUntil && businessDateOf(now) <= t.founderUntil ? FOUNDER.discountPct : 0;
  return withDiscount(new Decimal(planById(t.plan).priceUsd), pct);
}

// ---------------------------------------------------------------- el invitado

/**
 * +50 mensajes de prueba del invitado (US-423, A39): una vez, en la prueba y sin el tope de la
 * prueba alcanzado; su costo se reserva sin mirar el tope (no lo detiene). Devuelve el tope nuevo.
 */
export async function grantInviteeMessages(
  tx: Tx,
  tenantId: string,
  now: Date,
): Promise<number | null> {
  const [t] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId));
  if (!t || t.status !== "trial") return null;
  if ((await trialSpend(tx, t)).reached) return null;
  const internal = isInternalTenant(t);
  const done = await tx
    .insert(schema.rewardGrant)
    .values({
      tenantId,
      kind: "ref_invitee_msgs",
      status: internal ? "test" : "applied",
      appliedAs: "messages",
      appliedAt: now,
      costUsdEstimate: REFERRAL.inviteeCostUsd.toFixed(2),
      bookedMonth: internal ? null : caracasMonth(now).key,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.rewardGrant.id });
  if (!done[0]) return null;
  const after = await addExtraMessages(tx, t, REFERRAL.inviteeMsgs, null, now, "referral");
  if (!internal)
    await bookRewardCost(tx, caracasMonth(now).key, new Decimal(REFERRAL.inviteeCostUsd), true);
  return after;
}

export type LateOutcome =
  | { kind: "attached"; code: string; tope: number | null }
  | { kind: "not_found" }
  | { kind: "not_valid" }
  | { kind: "too_late" }
  | { kind: "closed" };

/**
 * «me invitó CODE» después del registro (US-421, RW-late), solo el dueño: dentro de 7 días, una
 * vez, máx. 3 intentos (los equivocados cuentan) y nunca después de un pago de plan aprobado (P-17:
 * esos dos, sin buscar el código). Con la unión, +50 si está en la prueba y sin el tope (P-9).
 */
export async function lateCode(
  tx: Tx,
  tenantId: string,
  text: string,
  now: Date,
): Promise<LateOutcome> {
  const code = parseInviteCode(text, { alone: false });
  const [t] = await tx
    .select()
    .from(schema.tenant)
    .where(eq(schema.tenant.id, tenantId))
    .for("update");
  if (!t || !code) return { kind: "not_found" };
  const [paid] = await tx
    .select({ id: schema.payment.id })
    .from(schema.payment)
    .where(
      and(
        eq(schema.payment.tenantId, tenantId),
        eq(schema.payment.kind, "plan"),
        eq(schema.payment.status, "approved"),
      ),
    )
    .limit(1);
  if (paid || t.referralLateAttempts >= REFERRAL.lateAttempts) return { kind: "closed" };
  if (now.getTime() - t.createdAt.getTime() > REFERRAL.lateDays * DAY_MS)
    return { kind: "too_late" };
  await tx
    .update(schema.tenant)
    .set({ referralLateAttempts: t.referralLateAttempts + 1 })
    .where(eq(schema.tenant.id, tenantId));
  const r = await attachReferral(tx, code, "late");
  if (r === "already") return { kind: "too_late" };
  if (r === "not_found") return { kind: "not_found" };
  if (r !== "attached") return { kind: "not_valid" };
  const tope = await grantInviteeMessages(tx, tenantId, now);
  return { kind: "attached", code, tope };
}

/** Une en el registro (chat o web) y da el +50 (US-421, US-423). Devuelve el tope nuevo o null. */
export async function attachAtSignup(
  tx: Tx,
  tenantId: string,
  code: string,
  via: "web" | "chat",
  now: Date,
): Promise<number | null> {
  if (!isCodeShape(code)) return null;
  if ((await attachReferral(tx, code, via)) !== "attached") return null;
  return grantInviteeMessages(tx, tenantId, now);
}

// ---------------------------------------------------------------- el mes de regalo

export class ReviewRefused extends Error {
  constructor(public readonly reason: "state" | "too_soon") {
    super(`revisión rechazada: ${reason}`);
    this.name = "ReviewRefused";
  }
}

/**
 * El fundador aprueba un mes de regalo (US-422, SEC-P4-11): solo desde `pending_review` y al menos
 * 7 días después de que se aprobó el pago del invitado, mirado en la base. Con el plan pagando,
 * +30 días a `paid_until` (`reward_ref_month`) y RW8c-paid; si no, espera el próximo pago
 * (RW8c-paid-trial). Repetirlo no hace nada.
 */
export async function approveRefMonth(
  tx: Tx,
  tenantId: string,
  grantId: string,
  reviewer: { userId: string; email: string },
  now: Date,
): Promise<"applied" | "waiting"> {
  const [g] = await tx
    .update(schema.rewardGrant)
    .set({ status: "waiting", waitReason: null, updatedAt: now })
    .where(
      and(
        eq(schema.rewardGrant.id, grantId),
        eq(schema.rewardGrant.tenantId, tenantId),
        eq(schema.rewardGrant.kind, "ref_month"),
        eq(schema.rewardGrant.status, "pending_review"),
        sql`${schema.rewardGrant.sourceApprovedAt} <= now() - interval '7 days'`,
      ),
    )
    .returning();
  if (!g) {
    const [cur] = await tx
      .select()
      .from(schema.rewardGrant)
      .where(eq(schema.rewardGrant.id, grantId));
    throw new ReviewRefused(cur?.status === "pending_review" ? "too_soon" : "state");
  }
  const [t] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId));
  if (t && isPaying(t, now) && t.paidUntil) {
    const paidUntil = new Date(t.paidUntil.getTime() + REFERRAL.monthDays * DAY_MS);
    await setTenantBilling(tx, t, { paidUntil }, reviewer, now, "reward_ref_month");
    await tx
      .update(schema.rewardGrant)
      .set({ status: "applied", appliedAs: "month", appliedAt: now, updatedAt: now })
      .where(eq(schema.rewardGrant.id, g.id));
    await addNotice(
      tx,
      tenantId,
      "ref_paid",
      { k: POINT_RULES.ref_paid, fin: businessDateOf(paidUntil) },
      now,
    );
    return "applied";
  }
  await tx
    .update(schema.rewardGrant)
    .set({ waitReason: "not_paying", updatedAt: now })
    .where(eq(schema.rewardGrant.id, g.id));
  await addNotice(tx, tenantId, "ref_paid_wait", { k: POINT_RULES.ref_paid }, now);
  return "waiting";
}

/** El fundador rechaza un mes de regalo (US-422): solo desde `pending_review`; RW8e. El +100 queda. */
export async function refuseRefMonth(
  tx: Tx,
  tenantId: string,
  grantId: string,
  now: Date,
): Promise<void> {
  const [g] = await tx
    .update(schema.rewardGrant)
    .set({ status: "refused", updatedAt: now })
    .where(
      and(
        eq(schema.rewardGrant.id, grantId),
        eq(schema.rewardGrant.tenantId, tenantId),
        eq(schema.rewardGrant.kind, "ref_month"),
        eq(schema.rewardGrant.status, "pending_review"),
      ),
    )
    .returning();
  if (!g) throw new ReviewRefused("state");
  await addNotice(tx, tenantId, "ref_refused", {}, now);
}

/**
 * Al aprobarse un pago de plan de quien invita: los meses de regalo que esperaban un pago se suman
 * (+30 días cada uno) si tienen menos de 12 meses; los más viejos vencen (§P4.7 item 3). RW8a-ref
 * con el aviso de pago verificado.
 */
export async function releaseRefMonths(
  tx: Tx,
  tenantId: string,
  paymentId: string,
  now: Date,
): Promise<number> {
  const waiting = await tx
    .select()
    .from(schema.rewardGrant)
    .where(
      and(
        eq(schema.rewardGrant.tenantId, tenantId),
        eq(schema.rewardGrant.kind, "ref_month"),
        eq(schema.rewardGrant.status, "waiting"),
        eq(schema.rewardGrant.waitReason, "not_paying"),
      ),
    );
  let n = 0;
  for (const g of waiting) {
    const lapsed = now.getTime() - g.createdAt.getTime() > YEAR_MS;
    const [claimed] = await tx
      .update(schema.rewardGrant)
      .set(
        lapsed
          ? {
              status: "cancelled",
              waitReason: null,
              flags: { ...(g.flags as object), lapsed: true },
              updatedAt: now,
            }
          : {
              status: "applied",
              waitReason: null,
              appliedAs: "month",
              appliedAt: now,
              updatedAt: now,
            },
      )
      .where(and(eq(schema.rewardGrant.id, g.id), eq(schema.rewardGrant.status, "waiting")))
      .returning();
    if (!claimed || lapsed) continue;
    const [t] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId));
    if (!t?.paidUntil) continue;
    const paidUntil = new Date(t.paidUntil.getTime() + REFERRAL.monthDays * DAY_MS);
    await setTenantBilling(tx, t, { paidUntil }, null, now, "reward_ref_month");
    await addNotice(
      tx,
      tenantId,
      "ref_month_paid",
      { fin: businessDateOf(paidUntil), paymentId },
      now,
    );
    n += 1;
  }
  return n;
}

/** Una fila de «Mi gente»: solo el número y el paso. */
export type PersonRow = { n: number; stage: "signed_up" | "active" | "paid" };

/**
 * «Mi gente» (RW5-6, A43, PV-1): «Persona N» con el paso, desde «se registró»; nunca `returning`,
 * vencidas, devueltas, rechazadas ni un invitado en la papelera.
 */
export async function myPeople(tx: Tx, tenantId: string): Promise<PersonRow[]> {
  const list = await myReferrals(tx);
  const refused = new Set(
    (
      await tx
        .select({ referralId: schema.rewardGrant.referralId })
        .from(schema.rewardGrant)
        .where(
          and(
            eq(schema.rewardGrant.tenantId, tenantId),
            eq(schema.rewardGrant.kind, "ref_month"),
            eq(schema.rewardGrant.status, "refused"),
          ),
        )
    ).map((g) => g.referralId),
  );
  return list
    .filter((r) => r.stage !== "ended" && !r.inviteeTrashed && !refused.has(r.id))
    .map((r, i) => ({ n: i + 1, stage: r.stage as PersonRow["stage"] }));
}
