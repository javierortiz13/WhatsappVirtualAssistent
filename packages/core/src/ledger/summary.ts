import type { Tx } from "@caja/db";
import { asIsoDate, type IsoDate } from "../domain/dates";
import { es, type Outbound } from "../render/index";
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from "./income";
import { categoryTotal, dailyClose, type PeriodKey, periodSummary, resolvePeriod } from "./reports";

/**
 * Decide qué responder a una consulta: un solo día → cierre diario; un rango → resumen del
 * período; con categoría → total de esa categoría. Sin movimientos, lo dice sin ceros.
 */
export async function renderSummary(
  tx: Tx,
  input: {
    tenantId: string;
    today: IsoDate;
    dashboardUrl: string;
    period: PeriodKey;
    from: string | null;
    to: string | null;
    categoryName: string | null;
  },
): Promise<Outbound> {
  const range = resolvePeriod(input.period, input.today, {
    from: input.from ? asIsoDate(input.from) : null,
    to: input.to ? asIsoDate(input.to) : null,
  });
  if ("error" in range) {
    if (range.error === "too_long") return es.periodTooLong(input.dashboardUrl);
    return es.clarification("¿De qué fechas? Ejemplo: _del 1 al 15 de septiembre_", []);
  }
  const label = es.periodLabel(input.period, range.from, range.to, input.today);
  if (input.categoryName) {
    const r = await categoryTotal(tx, input.tenantId, range.from, range.to, input.categoryName);
    if (!r.found) return es.categoryNotFound(input.categoryName, r.suggestions);
    return es.categoryTotal({
      name: r.name,
      periodLabel: label,
      usd: r.usd,
      ves: r.ves,
      count: r.count,
    });
  }
  if (range.from === range.to) {
    const c = await dailyClose(tx, input.tenantId, range.from);
    if (c.count === 0) return es.noMovements(label);
    return es.dailyClose({
      ...c,
      today: input.today,
      salesByMethod: c.salesByMethod.map((m) => ({
        label: PAYMENT_METHOD_LABELS[m.method as PaymentMethod] ?? m.method,
        usd: m.usd,
        originalVes: m.originalVes,
      })),
      dashboardUrl: input.dashboardUrl,
    });
  }
  const p = await periodSummary(tx, input.tenantId, range.from, range.to);
  if (p.count === 0) return es.noMovements(label);
  const title =
    input.period === "this_month" || input.period === "last_month"
      ? `Cierre del mes · ${label.charAt(0).toUpperCase()}${label.slice(1)}`
      : `Resumen · ${label}`;
  return es.periodSummary({ ...p, title, dashboardUrl: input.dashboardUrl });
}
