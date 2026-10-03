import type { Tx } from "@caja/db";
import { businessDateOf } from "../domain/dates";
import { es, type Outbound } from "../render/index";
import { type PlanId, planById } from "./plans";
import type { BillingMethod, Quote } from "./pricing";
import {
  BILLING_METHODS,
  currentRenewIntent,
  extractReference,
  type PaymentDest,
  type RenewIntent,
  renewalOffer,
  reportRenewal,
  startRenewal,
} from "./renew";

/**
 * Las respuestas del bot para renovar el plan (03/10). Las usan el router determinista (botones,
 * referencia, negocio suspendido) y la herramienta `renew_plan` del agente.
 */
export type RenewChatCtx = {
  tenantId: string;
  phoneId: string;
  now: Date;
  dest: PaymentDest;
  supportHint: string | null;
};

const view = (q: Quote | RenewIntent) => ({
  method: q.method,
  currency: q.currency,
  amount: q.amount,
  rateKind: q.rateKind,
  rateValue: q.rateValue,
});

/** Plan, vencimiento y montos con un botón por método. */
export async function renewOfferReply(
  tx: Tx,
  c: RenewChatCtx,
  opts: { plan?: PlanId | null; months?: number | null } = {},
): Promise<Outbound> {
  const o = await renewalOffer(tx, c.tenantId, c.now, c.dest, opts);
  return es.renewOffer({
    planName: o.plan.name,
    planId: o.plan.id,
    fromPlanName: o.plan.id === o.currentPlanId ? null : planById(o.currentPlanId).name,
    stateKind: o.state.kind,
    endsAt: o.state.endsAt ? businessDateOf(o.state.endsAt) : null,
    daysLeft: o.state.daysLeft,
    months: o.months,
    quotes: o.quotes.map(view),
    supportHint: c.supportHint,
  });
}

/** Eligió método: datos de pago y monto exacto; queda la intención esperando la referencia. */
export async function renewPayToReply(
  tx: Tx,
  c: RenewChatCtx,
  input: { method: BillingMethod; plan: PlanId; months: number },
): Promise<Outbound> {
  const dest = c.dest[input.method];
  if (!dest) return renewOfferReply(tx, c, { plan: input.plan, months: input.months });
  const r = await startRenewal(tx, c, input, c.now);
  if (!r) return es.renewUnavailable(c.supportHint);
  return es.renewPayTo({
    quote: view(r.intent),
    dest,
    planName: r.plan.name,
    months: r.intent.months,
  });
}

/** Llegó la referencia: reporta el pago o, sin método conocido, pregunta por dónde pagó. */
export async function renewReferenceReply(
  tx: Tx,
  c: RenewChatCtx,
  reference: string,
  method: BillingMethod | null = null,
): Promise<Outbound> {
  const r = await reportRenewal(tx, c, reference, c.now, method);
  if (r.kind === "too_many") return es.renewTooMany(c.supportHint);
  if (r.kind === "no_intent") {
    const methods = BILLING_METHODS.filter((m) => c.dest[m]);
    if (methods.length === 0) return renewOfferReply(tx, c);
    return es.renewWhichMethod(reference, methods);
  }
  return es.renewReported({
    quote: view(r.intent),
    planName: r.plan.name,
    months: r.intent.months,
    reference: r.reference,
  });
}

/** Si el mensaje trae la referencia de un pago (con intención abierta o "ref …"), la reporta. */
export async function maybeRenewReference(
  tx: Tx,
  c: RenewChatCtx,
  text: string,
): Promise<Outbound | null> {
  const open = await currentRenewIntent(tx, c.phoneId, c.now);
  const reference = extractReference(text, open !== null);
  if (!reference || !open) return null;
  return renewReferenceReply(tx, c, reference);
}

/** Palabras con las que un negocio suspendido pide renovar (sin LLM). */
export const RENEW_WORDS =
  /(renov|\bpag(ar|o|ue|ué)\b|\bplan\b|suscrip|precio|cu[aá]nto cuesta|activar|reactivar)/i;
