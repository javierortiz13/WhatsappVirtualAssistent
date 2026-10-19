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
    /** Cuenta personal: "Ingresos" por fuente, y la categoría puede ser una fuente de ingreso. */
    personal?: boolean;
  },
): Promise<Outbound> {
  const personal = input.personal ?? false;
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
    const name = input.categoryName;
    const expense = await categoryTotal(tx, input.tenantId, range.from, range.to, name);
    // En una cuenta personal también puede preguntar por una fuente ("cuánto me entró de
    // freelance"): gana la que se llama igual; si no, la de gasto, y si no hay, la de ingreso.
    const income = personal
      ? await categoryTotal(tx, input.tenantId, range.from, range.to, name, "income")
      : null;
    const same = (n: string) => plain(n).includes(plain(name)) || plain(name).includes(plain(n));
    const r =
      income?.found && (same(income.name) || !expense.found)
        ? { ...income, kind: "income" as const }
        : { ...expense, kind: "expense" as const };
    if (!r.found) return es.categoryNotFound(name, expense.found ? [] : expense.suggestions);
    // El panel lista por mes: el del final del período.
    const q = new URLSearchParams({ mes: range.to.slice(0, 7), tipo: r.kind, categoria: r.id });
    return es.categoryTotal({
      kind: r.kind,
      name: r.name,
      periodLabel: label,
      usd: r.usd,
      ves: r.ves,
      count: r.count,
      items: r.items,
      link: `${input.dashboardUrl}/movimientos?${q.toString()}`,
    });
  }
  if (range.from === range.to) {
    const c = await dailyClose(tx, input.tenantId, range.from);
    if (c.count === 0) return es.noMovements(label, personal);
    return es.dailyClose({
      ...c,
      personal,
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
  if (p.count === 0) return es.noMovements(label, personal);
  const title =
    input.period === "this_month" || input.period === "last_month"
      ? `Cierre del mes · ${label.charAt(0).toUpperCase()}${label.slice(1)}`
      : `Resumen · ${label}`;
  return es.periodSummary({ ...p, personal, title, dashboardUrl: input.dashboardUrl });
}

const plain = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
