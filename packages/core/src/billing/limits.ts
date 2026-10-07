import type { schema, Tx } from "@caja/db";
import { CAP_WARN_PCT, planById } from "./plans";
import { subscriptionState } from "./subscription";
import { caracasMonth, monthUsage } from "./usage";

/**
 * Límite duro del plan (0019, decisión de Javier del 07/10): un plan pagado incluye N mensajes
 * al mes (los que el usuario manda; las respuestas no cuentan) más las recargas del mes. Al
 * pasarlos, Rocco deja de registrar y ofrece recargar o cambiar de plan; al 80 % avisa una vez.
 * La prueba gratis no usa este límite: tiene su tope de gasto (0016).
 */
export type CapStatus = {
  month: string;
  used: number;
  /** Mensajes del plan más la recarga de este mes. */
  cap: number;
  planCap: number;
  extra: number;
  reached: boolean;
  /** Pasó el 80 % y todavía no se avisó este mes. */
  warn: boolean;
};

export async function planCapStatus(
  tx: Tx,
  t: typeof schema.tenant.$inferSelect,
  now: Date,
): Promise<CapStatus | null> {
  if (t.status === "trial" || t.deletedAt) return null;
  const kind = subscriptionState(t, now).kind;
  if (kind !== "active" && kind !== "grace") return null;
  const month = caracasMonth(now).key;
  const planCap = planById(t.plan).messagesPerMonth;
  const extra = t.extraMonth === month ? t.extraMessages : 0;
  const cap = planCap + extra;
  const used = (await monthUsage(tx, t.id, now)).inbound;
  const reached = used > cap;
  const warn = !reached && used * 100 >= cap * CAP_WARN_PCT && t.capWarnedMonth !== month;
  return { month, used, cap, planCap, extra, reached, warn };
}
