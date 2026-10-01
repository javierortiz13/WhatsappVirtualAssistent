import {
  dailyClose,
  PAYMENT_METHOD_LABELS,
  type PaymentMethod,
  periodSummary,
  resolvePeriod,
} from "@caja/core";
import { formatMoney, formatShortDate, monthNameEs } from "@caja/core/domain";
import { withTenant } from "@caja/db";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { todayInCaracas } from "@/lib/queries";
import { requireTenant } from "@/lib/session";

export const metadata: Metadata = { title: "Cierres" };
export const dynamic = "force-dynamic";

/** Mismas consultas que el bot: cierre de hoy y resumen del mes. */
export default async function Cierres() {
  const { tenant } = await requireTenant();
  const today = todayInCaracas();
  const month = resolvePeriod("this_month", today);
  const [close, summary] = await withTenant(db(), tenant.id, async (tx) => [
    await dailyClose(tx, tenant.id, today),
    "error" in month ? null : await periodSummary(tx, tenant.id, month.from, month.to),
  ]);
  return (
    <div className="stack">
      <h2 style={{ marginTop: 0 }}>Cierre de hoy · {formatShortDate(today)}</h2>
      {close.count === 0 ? (
        <p className="empty">No hay movimientos registrados hoy.</p>
      ) : (
        <div className="card stack">
          <div>
            <p className="kpi-label">Ventas</p>
            <p className="kpi">{formatMoney(close.salesUsd, "USD")}</p>
            <ul className="list">
              {close.salesByMethod.map((m) => (
                <li key={m.method}>
                  <span>{PAYMENT_METHOD_LABELS[m.method as PaymentMethod]}</span>
                  <span className="amt">{formatMoney(m.usd, "USD")}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="kpi-label">Gastos</p>
            <p className="kpi">{formatMoney(close.expensesUsd, "USD")}</p>
            <ul className="list">
              {close.expensesByCategory.map((c) => (
                <li key={c.name}>
                  <span>{c.name}</span>
                  <span className="amt">{formatMoney(c.usd, "USD")}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="kpi-label">Ventas menos gastos</p>
            <p className="kpi">{formatMoney(close.netUsd, "USD")}</p>
            {close.netVes !== null && close.rateValue !== null ? (
              <p className="kpi-sub">
                {formatMoney(close.netVes, "VES")} a tasa{" "}
                {formatMoney(close.rateValue, "VES").replace("Bs ", "")}
              </p>
            ) : null}
            <p className="kpi-sub">
              Efectivo en caja: {formatMoney(close.cashUsd, "USD")} ·{" "}
              {formatMoney(close.cashVes, "VES")}
            </p>
          </div>
        </div>
      )}
      <h2>
        {monthNameEs(today)}
        {"error" in month ? null : (
          <a
            className="chip"
            style={{ marginLeft: 12, fontWeight: 400 }}
            href={`/exportar?desde=${month.from}&hasta=${month.to}`}
          >
            ⬇ Excel del mes
          </a>
        )}
      </h2>
      {!summary || summary.count === 0 ? (
        <p className="empty">Sin movimientos este mes.</p>
      ) : (
        <div className="card stack">
          <div className="grid-2">
            <div>
              <p className="kpi-label">Ventas</p>
              <p className="kpi">{formatMoney(summary.salesUsd, "USD")}</p>
            </div>
            <div>
              <p className="kpi-label">Gastos</p>
              <p className="kpi">{formatMoney(summary.expensesUsd, "USD")}</p>
            </div>
          </div>
          <div>
            <p className="kpi-label">Ventas menos gastos</p>
            <p className="kpi">{formatMoney(summary.netUsd, "USD")}</p>
            <p className="kpi-sub">
              {summary.daysWithMovements === 1 ? "1 día" : `${summary.daysWithMovements} días`} con
              movimientos
            </p>
          </div>
          {summary.topExpenses.length ? (
            <div>
              <p className="kpi-label">Gastos más grandes</p>
              <ul className="list">
                {summary.topExpenses.map((c) => (
                  <li key={c.name}>
                    <span>{c.name}</span>
                    <span className="amt">{formatMoney(c.usd, "USD")}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
