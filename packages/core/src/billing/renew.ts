import { and, desc, eq, gte, inArray, isNull, schema, type Tx } from "@caja/db";
import { z } from "zod";
import { businessDateOf } from "../domain/dates";
import { Decimal } from "../domain/money";
import { reportPayment, TooManyPendingError } from "./payments";
import { FOUNDER, PLANS, type Plan, type PlanId, planById, RECHARGE } from "./plans";
import { type BillingMethod, latestRates, type Quote, quote, quoteUsd } from "./pricing";
import { type SubscriptionState, subscriptionState } from "./subscription";

/**
 * Renovar el plan por WhatsApp (ADR-015 fase 2, 03/10/2026). El dueño pide renovar, elige el
 * método con un botón y recibe los datos y el monto exacto; el bot guarda esa intención
 * (`renew_plan`, 48 horas) y, cuando llega la referencia, reporta el pago como pendiente para que
 * el administrador lo verifique en la consola. Nada de esto pasa por el LLM salvo la entrada en
 * lenguaje natural de un plan activo.
 */
export type PaymentDest = Partial<Record<BillingMethod, string | null>>;

export const BILLING_METHODS: BillingMethod[] = ["pago_movil", "zelle", "binance"];
export const RENEW_TTL_MS = 48 * 60 * 60 * 1000;
export const MAX_MONTHS = 12;

export const RenewIntent = z.object({
  plan: z.enum(["personal", "negocio", "negocio_plus"]),
  months: z.number().int().min(1).max(MAX_MONTHS),
  method: z.enum(["pago_movil", "zelle", "binance"]),
  amount: z.string(),
  currency: z.enum(["VES", "USD", "USDT"]),
  amountUsd: z.string(),
  rateKind: z.enum(["bcv_usd", "bcv_eur"]).nullable(),
  rateValue: z.string().nullable(),
  /** Plan (extiende la vigencia) o recarga de mensajes del mes (0019). */
  kind: z.enum(["plan", "recharge"]).default("plan"),
});
export type RenewIntent = z.infer<typeof RenewIntent>;

/** Descuento fundador vigente (0019): el porcentaje si `founder_until` no ha pasado. */
export function founderDiscount(t: { founderUntil: string | null }, now: Date): number {
  return t.founderUntil && businessDateOf(now) <= t.founderUntil ? FOUNDER.discountPct : 0;
}

export type RenewalOffer = {
  plan: Plan;
  /** Plan actual del negocio (puede diferir de `plan` si pidió cambiarse). */
  currentPlanId: PlanId;
  months: number;
  state: SubscriptionState;
  quotes: Quote[];
  /** Precio fundador aplicado (0019): porcentaje y hasta cuándo. */
  founder: { pct: number; until: string } | null;
};

const clampMonths = (n: number | null | undefined) =>
  Math.min(MAX_MONTHS, Math.max(1, Number.isInteger(n) ? (n as number) : 1));

async function tenantRow(tx: Tx, tenantId: string) {
  const [t] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId));
  if (!t) throw new Error("negocio no encontrado");
  return t;
}

/**
 * Qué cuesta renovar: el plan actual (o el que pidió) por `months`, con el monto por cada
 * método que tenga datos de cobro configurados.
 */
export async function renewalOffer(
  tx: Tx,
  tenantId: string,
  now: Date,
  dest: PaymentDest,
  opts: { plan?: PlanId | null; months?: number | null } = {},
): Promise<RenewalOffer> {
  const t = await tenantRow(tx, tenantId);
  const current = planById(t.plan).id;
  const plan = planById(opts.plan ?? current);
  const months = clampMonths(opts.months);
  const rates = await latestRates(tx);
  const pct = founderDiscount(t, now);
  const quotes = BILLING_METHODS.filter((m) => dest[m])
    .map((m) => quote(plan, m, months, rates, "bcv_eur", pct))
    .filter((q): q is Quote => q !== null);
  return {
    plan,
    currentPlanId: current,
    months,
    state: subscriptionState(t, now),
    quotes,
    founder: pct && t.founderUntil ? { pct, until: t.founderUntil } : null,
  };
}

/** Lo que cuesta una recarga de mensajes por cada método configurado. */
export async function rechargeQuotes(tx: Tx, dest: PaymentDest): Promise<Quote[]> {
  const rates = await latestRates(tx);
  return BILLING_METHODS.filter((m) => dest[m])
    .map((m) => quoteUsd(new Decimal(RECHARGE.priceUsd), m, rates))
    .filter((q): q is Quote => q !== null);
}

/** El dueño eligió método: guarda la intención (reemplaza la anterior) y devuelve el monto. */
export async function startRenewal(
  tx: Tx,
  ref: { tenantId: string; phoneId: string },
  input: { method: BillingMethod; plan: PlanId; months: number; kind?: "plan" | "recharge" },
  now: Date,
): Promise<{ intent: RenewIntent; plan: Plan } | null> {
  const t = await tenantRow(tx, ref.tenantId);
  const recharge = input.kind === "recharge";
  // La recarga queda a nombre del plan actual; no cambia el plan ni la vigencia.
  const plan = planById(recharge ? t.plan : input.plan);
  const months = recharge ? 1 : clampMonths(input.months);
  const rates = await latestRates(tx);
  const q = recharge
    ? quoteUsd(new Decimal(RECHARGE.priceUsd), input.method, rates)
    : quote(plan, input.method, months, rates, "bcv_eur", founderDiscount(t, now));
  if (!q) return null;
  const intent: RenewIntent = {
    plan: plan.id,
    months,
    method: input.method,
    amount: q.amount.toFixed(2),
    currency: q.currency,
    amountUsd: q.amountUsd.toFixed(2),
    rateKind: q.rateKind,
    rateValue: q.rateValue ? q.rateValue.toString() : null,
    kind: recharge ? "recharge" : "plan",
  };
  await tx
    .update(schema.pendingAction)
    .set({ status: "cancelled", resolvedAt: now })
    .where(
      and(
        eq(schema.pendingAction.phoneId, ref.phoneId),
        eq(schema.pendingAction.kind, "renew_plan"),
        eq(schema.pendingAction.status, "pending"),
      ),
    );
  await tx.insert(schema.pendingAction).values({
    tenantId: ref.tenantId,
    phoneId: ref.phoneId,
    kind: "renew_plan",
    payload: intent,
    expiresAt: new Date(now.getTime() + RENEW_TTL_MS),
  });
  return { intent, plan };
}

/** La intención de pago vigente del teléfono, si la hay. */
export async function currentRenewIntent(
  tx: Tx,
  phoneId: string,
  now: Date,
): Promise<{ id: string; intent: RenewIntent } | null> {
  const [row] = await tx
    .select()
    .from(schema.pendingAction)
    .where(
      and(
        eq(schema.pendingAction.phoneId, phoneId),
        eq(schema.pendingAction.kind, "renew_plan"),
        eq(schema.pendingAction.status, "pending"),
        gte(schema.pendingAction.expiresAt, now),
      ),
    )
    .orderBy(desc(schema.pendingAction.createdAt))
    .limit(1);
  if (!row) return null;
  const parsed = RenewIntent.safeParse(row.payload);
  return parsed.success ? { id: row.id, intent: parsed.data } : null;
}

const REF_KEYWORD =
  /(?:ref(?:erencia)?|n[uú]mero de (?:operaci[oó]n|confirmaci[oó]n|referencia)|confirmaci[oó]n|operaci[oó]n|comprobante|order id|id de orden)\s*[.:#nº°-]*\s*([a-z0-9-]{4,30})/i;
const PAID = /\b(pagu[eé]|ya pag|transfer[ií]|hice el pago|realic[eé] el pago)/i;
const MONEY = /(\$|\bbs\b|bol[ií]var|d[oó]lar|usd|usdt|euro)/i;

/**
 * La referencia de un pago en un mensaje: "ref 123456", "referencia: 0001234", "número de
 * confirmación JPM99ABC12". Con una intención de pago abierta también valen "ya pagué, 12345678"
 * (6 dígitos o más, sin moneda) y un mensaje que es solo el número. "Pagué 1500 bs de luz" es un
 * gasto, no una referencia.
 */
export function extractReference(text: string, hasIntent: boolean): string | null {
  const t = text.trim();
  const kw = REF_KEYWORD.exec(t);
  if (kw?.[1] && /\d/.test(kw[1])) return kw[1].toUpperCase();
  if (!hasIntent) return null;
  if (PAID.test(t) && !MONEY.test(t)) {
    const digits = /\b(\d{6,20})\b/.exec(t);
    if (digits?.[1]) return digits[1];
  }
  if (/^[#nº°.\s]*\d{4,20}\s*$/i.test(t)) return t.replace(/\D/g, "");
  return null;
}

export type RenewReport =
  | { kind: "reported"; intent: RenewIntent; plan: Plan; reference: string }
  | { kind: "too_many" }
  | { kind: "no_intent" };

/**
 * Reporta el pago con la referencia. Usa la intención abierta; sin ella, con `method` arma una
 * con el plan actual por un mes. Sin intención ni método devuelve `no_intent` (pedir el método).
 */
export async function reportRenewal(
  tx: Tx,
  ref: { tenantId: string; phoneId: string },
  reference: string,
  now: Date,
  method: BillingMethod | null = null,
): Promise<RenewReport> {
  let open = await currentRenewIntent(tx, ref.phoneId, now);
  if (!open && method) {
    const t = await tenantRow(tx, ref.tenantId);
    await startRenewal(tx, ref, { method, plan: planById(t.plan).id, months: 1 }, now);
    open = await currentRenewIntent(tx, ref.phoneId, now);
  }
  if (!open) return { kind: "no_intent" };
  const i = open.intent;
  try {
    await reportPayment(
      tx,
      {
        tenantId: ref.tenantId,
        plan: i.plan,
        months: i.months,
        method: i.method,
        amount: new Decimal(i.amount),
        currency: i.currency,
        rateKind: i.rateKind,
        rateValue: i.rateValue ? new Decimal(i.rateValue) : null,
        amountUsd: new Decimal(i.amountUsd),
        reference: reference.slice(0, 60),
        notes: i.kind === "recharge" ? "Recarga reportada por WhatsApp" : "Reportado por WhatsApp",
        kind: i.kind,
      },
      { phoneId: ref.phoneId },
      now,
    );
  } catch (err) {
    if (err instanceof TooManyPendingError) return { kind: "too_many" };
    throw err;
  }
  await tx
    .update(schema.pendingAction)
    .set({ status: "confirmed", resolvedAt: now })
    .where(eq(schema.pendingAction.id, open.id));
  return { kind: "reported", intent: i, plan: planById(i.plan), reference };
}

/** Plan pedido por nombre ("pásame a negocio plus"); null si no se nombró uno válido. */
export function planFromName(name: string | null | undefined): PlanId | null {
  if (!name) return null;
  return PLANS.find((p) => p.id === name)?.id ?? null;
}

export type PaymentNotice = {
  paymentId: string;
  status: "approved" | "rejected";
  kind: "plan" | "recharge";
  plan: Plan;
  amount: string;
  currency: "VES" | "USD" | "USDT";
  reference: string | null;
  reason: string | null;
  paidUntil: Date | null;
  /** Teléfono del dueño, solo si escribió en las últimas 24 horas (ventana de servicio de Meta). */
  to: { phoneId: string; e164: string } | null;
};

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Pagos revisados que todavía no se avisaron. Se marcan avisados de una vez: si el dueño no
 * escribió en 24 horas, Meta exige plantilla y el aviso no sale (lo ve en "Mi plan").
 */
export async function takePaymentNotices(
  tx: Tx,
  tenantId: string,
  now: Date,
): Promise<PaymentNotice[]> {
  const pays = await tx
    .select()
    .from(schema.payment)
    .where(
      and(
        eq(schema.payment.tenantId, tenantId),
        inArray(schema.payment.status, ["approved", "rejected"]),
        isNull(schema.payment.notifiedAt),
      ),
    );
  if (pays.length === 0) return [];
  const t = await tenantRow(tx, tenantId);
  const [owner] = await tx
    .select({ id: schema.phoneNumber.id, e164: schema.phoneNumber.e164 })
    .from(schema.phoneNumber)
    .where(
      and(
        eq(schema.phoneNumber.tenantId, tenantId),
        eq(schema.phoneNumber.role, "owner"),
        eq(schema.phoneNumber.status, "active"),
      ),
    )
    .limit(1);
  let to: PaymentNotice["to"] = null;
  if (owner?.e164) {
    const [last] = await tx
      .select({ at: schema.message.createdAt })
      .from(schema.message)
      .where(
        and(
          eq(schema.message.phoneId, owner.id),
          eq(schema.message.direction, "in"),
          gte(schema.message.createdAt, new Date(now.getTime() - WINDOW_MS)),
        ),
      )
      .limit(1);
    if (last) to = { phoneId: owner.id, e164: owner.e164 };
  }
  await tx
    .update(schema.payment)
    .set({ notifiedAt: now })
    .where(
      inArray(
        schema.payment.id,
        pays.map((p) => p.id),
      ),
    );
  return pays.map((p) => ({
    paymentId: p.id,
    status: p.status as "approved" | "rejected",
    kind: p.kind === "recharge" ? "recharge" : "plan",
    plan: planById(p.plan),
    amount: p.amount,
    currency: p.currency as PaymentNotice["currency"],
    reference: p.reference,
    reason: p.status === "rejected" ? p.notes : null,
    paidUntil: p.status === "approved" ? t.paidUntil : null,
    to,
  }));
}
