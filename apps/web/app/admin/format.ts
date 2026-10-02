import type { SubscriptionState } from "@caja/core";
import { businessDateOf, Decimal, formatMoney, formatShortDate } from "@caja/core/domain";

export const usd = (v: Decimal.Value) => {
  const d = new Decimal(v);
  // "−$0,12" y no "$-0,12".
  return d.isNegative() ? `−${formatMoney(d.abs(), "USD")}` : formatMoney(d, "USD");
};
export const ves = (v: Decimal.Value) => formatMoney(new Decimal(v), "VES");

export const METHOD_LABEL: Record<string, string> = {
  pago_movil: "Pago móvil",
  zelle: "Zelle",
  binance: "Binance",
};

export const STATE: Record<SubscriptionState["kind"], { label: string; cls: string }> = {
  trial: { label: "prueba", cls: "" },
  active: { label: "activo", cls: "ok" },
  grace: { label: "en gracia", cls: "warn" },
  expired: { label: "vencido", cls: "warn" },
  suspended: { label: "suspendido", cls: "warn" },
};

export const planClass = (id: string) => `plan-${id}`;

/** Ámbar mientras vence; rojo si ya venció o está suspendido. */
export const dueClass = (s: SubscriptionState) =>
  s.kind === "grace" || s.kind === "expired" || s.kind === "suspended" ? "due late" : "due";

/** "vence en 5 días", "venció hace 2 días", "sin fecha". */
export function dueText(s: SubscriptionState): string {
  if (!s.endsAt || s.daysLeft === null) return "sin fecha de vencimiento";
  const d = s.daysLeft;
  const date = formatShortDate(businessDateOf(s.endsAt));
  if (d > 1) return `vence en ${d} días (${date})`;
  if (d === 1) return `vence mañana (${date})`;
  if (d === 0) return `vence hoy (${date})`;
  return `venció hace ${-d} ${d === -1 ? "día" : "días"} (${date})`;
}
