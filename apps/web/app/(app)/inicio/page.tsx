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
import { rows, schema, sql, withTenant } from "@caja/db";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { BOT_FEATURES } from "@/lib/onboarding";
import { monthBounds, movementsBetween, todayInCaracas, totalsBetween } from "@/lib/queries";
import { requireTenant } from "@/lib/session";
import { MovementRowView } from "../movements-list";

export const metadata: Metadata = { title: "Inicio" };
export const dynamic = "force-dynamic";

/** Una cifra grande (el neto de hoy), dos tarjetas del mes y los últimos movimientos. */
export default async function Inicio({
  searchParams,
}: {
  searchParams: Promise<{ bienvenida?: string }>;
}) {
  const { tenant } = await requireTenant();
  const sp = await searchParams;
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
  const progress = await withTenant(db(), tenant.id, async (tx) => {
    const [r] = rows<{ accounts: number; expenses: number; incomes: number; personal: boolean }>(
      await tx.execute(sql`
        select
          (select count(*)::int from ${schema.account}
            where tenant_id = ${tenant.id} and archived_at is null) as accounts,
          (select count(*)::int from ${schema.movement}
            where tenant_id = ${tenant.id} and type = 'expense' and deleted_at is null) as expenses,
          (select count(*)::int from ${schema.movement}
            where tenant_id = ${tenant.id} and type = 'income' and deleted_at is null) as incomes,
          (select business_type = 'personal' from ${schema.tenant}
            where id = ${tenant.id}) as personal
      `),
    );
    return r ?? { accounts: 0, expenses: 0, incomes: 0, personal: false };
  });
  const wa = env().PLATFORM_WA_NUMBER;
  const waLink = (text: string) =>
    wa ? `https://wa.me/${wa}?text=${encodeURIComponent(text)}` : "#";
  const steps = [
    {
      done: owner?.status === "active",
      title: "Vincular tu WhatsApp",
      sub: "Envía el código al asistente",
      href: "/registro",
    },
    {
      done: progress.accounts > 0,
      title: "Crear una cuenta",
      sub: "Tu banco, Binance o efectivo",
      href: "/ajustes/cuentas",
    },
    {
      done: progress.expenses > 0,
      title: "Registrar tu primer gasto",
      sub: "Escríbele: gasté 5$ en café",
      href: waLink("gasté 5$ en café"),
    },
    {
      done: progress.incomes > 0,
      title: progress.personal ? "Registrar un ingreso" : "Registrar una venta",
      sub: progress.personal ? "Escríbele: me pagaron 50$" : "Escríbele: hoy vendí 100$",
      href: waLink(progress.personal ? "me pagaron 50$" : "hoy vendí 100$"),
    },
  ];
  const doneCount = steps.filter((x) => x.done).length;
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

      {sp.bienvenida ? (
        <section className="card stack welcome">
          <div>
            <span className="label">¡Bienvenido!</span>
            <h2 style={{ fontSize: 22, margin: "6px 0 0" }}>Esto es lo que puedo hacer</h2>
            <p className="sub" style={{ margin: "6px 0 0" }}>
              Todo por WhatsApp: escribe, manda un audio o una foto.
            </p>
          </div>
          <div className="feature-grid">
            {BOT_FEATURES.map((f) => (
              <div className="feature" key={f.title}>
                <span className="feature-icon">{f.icon}</span>
                <strong className="feature-title">{f.title}</strong>
                <em className="feature-ex">{f.example}</em>
              </div>
            ))}
          </div>
          {wa ? (
            <a className="btn block wa" href={waLink("ayuda")} target="_blank" rel="noreferrer">
              Abrir WhatsApp
            </a>
          ) : null}
          <a className="sub center-text" href="/inicio" style={{ display: "block" }}>
            Cerrar
          </a>
        </section>
      ) : null}

      {doneCount < steps.length ? (
        <details className="card first-steps" open={Boolean(sp.bienvenida)}>
          <summary>
            🚀 Completa los primeros pasos
            <span className="count num">
              {doneCount}/{steps.length} ›
            </span>
          </summary>
          <div style={{ marginTop: "var(--space-2)" }}>
            {steps.map((x) => (
              <a
                key={x.title}
                className={`step-row ${x.done ? "done" : ""}`}
                href={x.href}
                {...(x.href.startsWith("https://") ? { target: "_blank", rel: "noreferrer" } : {})}
              >
                <span className="dot" aria-hidden="true" />
                <span className="what">
                  <strong className="step-title">{x.title}</strong>
                  <small>{x.sub}</small>
                </span>
              </a>
            ))}
          </div>
        </details>
      ) : null}

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
