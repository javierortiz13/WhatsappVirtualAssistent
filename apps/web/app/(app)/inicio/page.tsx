import { formatMoney, formatShortDate, getRateInfo } from "@caja/core";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { monthBounds, movementsBetween, todayInCaracas, totalsBetween } from "@/lib/queries";
import { requireTenant } from "@/lib/session";
import { MovementsList } from "../movements-list";

export const metadata: Metadata = { title: "Inicio" };
export const dynamic = "force-dynamic";

export default async function Inicio() {
  const { tenant } = await requireTenant();
  const today = todayInCaracas();
  const month = monthBounds(today);
  const [rate, todayTotals, monthTotals, recent] = await Promise.all([
    getRateInfo(db(), today),
    totalsBetween(tenant.id, today, today),
    totalsBetween(tenant.id, month.from, month.to),
    movementsBetween(tenant.id, month.from, month.to, 8),
  ]);
  return (
    <div className="stack">
      <div className="card rate">
        <div>
          <p className="kpi-label">Tasa BCV</p>
          {rate.current ? (
            <p className="kpi-sub">vigente {formatShortDate(rate.current.effectiveDate)}</p>
          ) : null}
        </div>
        <strong>{rate.current ? formatMoney(rate.current.value, "VES") : "sin tasa"}</strong>
      </div>
      {rate.stale ? <p className="warn">La tasa puede estar desactualizada.</p> : null}
      <div className="grid-2">
        <div className="card">
          <p className="kpi-label">Gastos de hoy</p>
          <p className="kpi">{formatMoney(todayTotals.expensesUsd, "USD")}</p>
          <p className="kpi-sub">
            {todayTotals.expenseCount === 1
              ? "1 registro"
              : `${todayTotals.expenseCount} registros`}
          </p>
        </div>
        <div className="card">
          <p className="kpi-label">Gastos del mes</p>
          <p className="kpi">{formatMoney(monthTotals.expensesUsd, "USD")}</p>
          <p className="kpi-sub">
            {monthTotals.expenseCount === 1
              ? "1 registro"
              : `${monthTotals.expenseCount} registros`}
          </p>
        </div>
      </div>
      <h2>Últimos movimientos</h2>
      <MovementsList rows={recent} today={today} />
    </div>
  );
}
