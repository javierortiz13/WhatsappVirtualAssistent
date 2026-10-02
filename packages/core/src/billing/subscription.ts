import { GRACE_DAYS } from "./plans";

/**
 * Estado de la suscripción de un negocio, calculado (no guardado) a partir de `tenant`:
 * - trial: dentro de los 14 días de prueba.
 * - active: pagado hasta `paid_until` (o activo sin fecha: cortesía).
 * - grace: venció hace menos de 3 días; el bot sigue funcionando.
 * - expired: pasó la gracia; el job lo suspende en la próxima vuelta.
 * - suspended: suspendido (por vencimiento o a mano); el bot no registra.
 */
export type SubscriptionKind = "trial" | "active" | "grace" | "expired" | "suspended";

export type SubscriptionState = {
  kind: SubscriptionKind;
  /** Fin de la prueba o del período pagado; null en un activo sin fecha. */
  endsAt: Date | null;
  /** Días enteros hasta `endsAt` (negativo si ya pasó). */
  daysLeft: number | null;
};

export type TenantBilling = {
  status: string;
  trialEndsAt: Date | null;
  paidUntil: Date | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function subscriptionState(t: TenantBilling, now: Date): SubscriptionState {
  const endsAt = t.status === "trial" ? t.trialEndsAt : t.paidUntil;
  const daysLeft = endsAt ? Math.ceil((endsAt.getTime() - now.getTime()) / DAY_MS) : null;
  if (t.status === "suspended") return { kind: "suspended", endsAt, daysLeft };
  if (!endsAt || endsAt.getTime() >= now.getTime())
    return { kind: t.status === "trial" ? "trial" : "active", endsAt, daysLeft };
  const graceEnd = endsAt.getTime() + GRACE_DAYS * DAY_MS;
  return { kind: now.getTime() <= graceEnd ? "grace" : "expired", endsAt, daysLeft };
}

/**
 * Nuevo fin del período al aprobar un pago: se suma desde lo que ocurra más tarde entre hoy, el
 * fin de lo ya pagado y el fin de la prueba. Pagar antes de tiempo no hace perder días.
 */
export function extendPaidUntil(
  t: TenantBilling,
  months: number,
  now: Date,
  periodDays: number,
): Date {
  const candidates = [now.getTime()];
  if (t.paidUntil) candidates.push(t.paidUntil.getTime());
  if (t.status === "trial" && t.trialEndsAt) candidates.push(t.trialEndsAt.getTime());
  return new Date(Math.max(...candidates) + months * periodDays * DAY_MS);
}
