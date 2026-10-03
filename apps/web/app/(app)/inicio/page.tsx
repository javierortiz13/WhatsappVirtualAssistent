import {
  BUDGET_WARN_PCT,
  type BudgetStatus,
  budgetStatuses,
  dailyClose,
  formatMoney,
  formatShortDate,
  getRateInfo,
  ownerPhone,
} from "@caja/core";
import { monthNameEs } from "@caja/core/domain";
import { withTenant } from "@caja/db";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { monthBounds, movementsBetween, todayInCaracas, totalsBetween } from "@/lib/queries";
import { requireTenant } from "@/lib/session";
import { MovementRowView } from "../movements-list";

export const metadata: Metadata = { title: "Inicio" };
export const dynamic = "force-dynamic";

/** Una cifra grande (el neto de hoy), dos tarjetas del mes y los últimos movimientos. */
export default async function Inicio() {
  const { tenant } = await requireTenant();
  const today = todayInCaracas();
  const month = monthBounds(today);
  const [rate, [close, budgets], monthTotals, recent, owner] = await Promise.all([
    getRateInfo(db(), today),
    withTenant(db(), tenant.id, (tx) =>
      Promise.all([dailyClose(tx, tenant.id, today), budgetStatuses(tx, tenant.id, today)]),
    ),
    totalsBetween(tenant.id, month.from, month.to),
    movementsBetween(tenant.id, month.from, month.to, 6),
    ownerPhone(db(), tenant.id),
  ]);
  const monthNet = monthTotals.incomeUsd.minus(monthTotals.expensesUsd);
  return (
    <div className="stack">
      {owner?.status === "pending" ? (
        <div className="notice err">
          <strong>Tu número todavía no está vinculado.</strong>{" "}
          <a href="/registro">Envía el código por WhatsApp</a> para empezar a registrar.
        </div>
      ) : null}
      {rate.stale ? <div className="notice">La tasa BCV puede estar desactualizada.</div> : null}

      <section className="card hero">
        <span className="label">Hoy · {formatShortDate(today)}</span>
        <p className={`big num ${close.netUsd.isNegative() ? "amber" : "mint"}`}>
          {formatMoney(close.netUsd, "USD")}
        </p>
        <p className="sub num">
          {close.netVes !== null ? `${formatMoney(close.netVes, "VES")} · ` : ""}
          {close.count === 0
            ? "sin movimientos todavía"
            : close.count === 1
              ? "1 movimiento"
              : `${close.count} movimientos`}
        </p>
        <div className="grid-2" style={{ marginTop: "var(--space-4)" }}>
          <div className="tile">
            <span className="label">Ventas</span>
            <strong className="num mint tile-n">{formatMoney(close.salesUsd, "USD")}</strong>
          </div>
          <div className="tile">
            <span className="label">Gastos</span>
            <strong className="num amber tile-n">{formatMoney(close.expensesUsd, "USD")}</strong>
          </div>
        </div>
      </section>

      <div className="grid-2">
        <div className="card">
          <span className="label">{monthNameEs(today)}</span>
          <p className={`kpi ${monthNet.isNegative() ? "amber" : ""}`}>
            {formatMoney(monthNet, "USD")}
          </p>
          <p className="kpi-sub num">
            <span className="mint">{formatMoney(monthTotals.incomeUsd, "USD")}</span>
            {" · "}
            <span className="amber">{formatMoney(monthTotals.expensesUsd, "USD")}</span>
          </p>
        </div>
        <div className="card">
          <span className="label">Efectivo en caja</span>
          <p className="kpi">{formatMoney(close.cashUsd, "USD")}</p>
          <p className="kpi-sub num">{formatMoney(close.cashVes, "VES")} en bolívares</p>
        </div>
      </div>

      {budgets.length ? <Budgets list={budgets} /> : null}

      <div className="day">
        <h2>Últimos movimientos</h2>
        <a className="sub" href="/movimientos">
          Ver todos ›
        </a>
      </div>
      {recent.length === 0 ? (
        <p className="empty">Todavía no hay movimientos este mes.</p>
      ) : (
        <div className="card tight">
          {recent.map((m) => (
            <MovementRowView key={m.id} m={m} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Una barra por presupuesto: verde, ámbar desde el 80 % y rojo en el tope o pasado. */
function Budgets({ list }: { list: BudgetStatus[] }) {
  return (
    <section className="card stack budgets">
      <div className="day">
        <h2>Presupuestos</h2>
        <a className="sub" href="/ajustes/categorias">
          Editar ›
        </a>
      </div>
      {list.map((b) => {
        const over = !b.remainingUsd.isPositive();
        const tone = over ? "over" : b.pct >= BUDGET_WARN_PCT ? "warn" : "";
        const days = b.daysLeft <= 1 ? "último día" : `faltan ${b.daysLeft} días`;
        return (
          <div className="budget-row" key={b.categoryId}>
            <div className="budget-head">
              <strong className="budget-name">{b.name}</strong>
              <span
                className={`budget-left num ${over ? "danger" : tone === "warn" ? "amber" : ""}`}
              >
                {b.remainingUsd.isNegative()
                  ? `pasado ${formatMoney(b.remainingUsd.abs(), "USD")}`
                  : `quedan ${formatMoney(b.remainingUsd, "USD")}`}
              </span>
            </div>
            <div className="usage" aria-hidden="true">
              <span style={{ width: `${Math.min(100, b.pct)}%` }} className={tone} />
            </div>
            <span className="sub num">
              {formatMoney(b.spentUsd, "USD")} de {formatMoney(b.amountUsd, "USD")} ·{" "}
              {b.period === "monthly" ? "mensual" : "quincenal"}, {days}
            </span>
          </div>
        );
      })}
    </section>
  );
}
