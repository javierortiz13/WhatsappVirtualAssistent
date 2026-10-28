import {
  type AccountView,
  accountBalances,
  BUDGET_WARN_PCT,
  type BudgetStatus,
  budgetStatuses,
  businessDateOf,
  type Decimal,
  dailyClose,
  es,
  formatMoney,
  formatShortDate,
  getRateInfo,
  habitSettings,
  incomeByCategory,
  netWorth,
  openReminders,
  ownerPhone,
  streakFor,
} from "@caja/core";
import { monthNameEs } from "@caja/core/domain";
import { rows, schema, sql, withTenant } from "@caja/db";
import type { Metadata } from "next";
import { accountKindLine, accountMoney } from "@/lib/accounts";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { BOT_FEATURES } from "@/lib/onboarding";
import { monthBounds, movementsBetween, todayInCaracas, totalsBetween } from "@/lib/queries";
import { requireTenant } from "@/lib/session";
import { CashNote } from "../cash-note";
import { IconWallet } from "../icons";
import { MovementRowView } from "../movements-list";
import { StreakCard } from "../streak-card";

export const metadata: Metadata = { title: "Inicio" };
export const dynamic = "force-dynamic";

/**
 * Una cifra grande (el neto de hoy), cuánto hay en cada cuenta, dos tarjetas del mes y los últimos
 * movimientos.
 */
export default async function Inicio({
  searchParams,
}: {
  searchParams: Promise<{ bienvenida?: string; recuperada?: string }>;
}) {
  const { tenant } = await requireTenant();
  const sp = await searchParams;
  const today = todayInCaracas();
  const month = monthBounds(today);
  const [rate, [close, budgets, accounts], monthTotals, recent, owner] = await Promise.all([
    getRateInfo(db(), today),
    withTenant(db(), tenant.id, (tx) =>
      Promise.all([
        dailyClose(tx, tenant.id, today),
        budgetStatuses(tx, tenant.id, today),
        accountBalances(tx, tenant.id),
      ]),
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
  // Tu racha (hábitos US-103), solo con su interruptor encendido.
  const habits = await habitSettings(db());
  const streak = habits.streakLine
    ? await withTenant(db(), tenant.id, (tx) => streakFor(tx, tenant.id, new Date()))
    : null;
  // Próximos recordatorios (hábitos US-309): los 3 más cercanos, solo al dueño.
  const nextReminders =
    habits.reminders && tenant.role === "owner"
      ? await withTenant(db(), tenant.id, (tx) => openReminders(tx, tenant.id, 3))
      : [];
  // Cuenta personal: lo que entró en el mes, por fuente (salario, freelance…).
  const sources = progress.personal
    ? await withTenant(db(), tenant.id, (tx) =>
        incomeByCategory(tx, tenant.id, month.from, month.to),
      )
    : [];
  const wa = env().PLATFORM_WA_NUMBER;
  const waLink = (text: string) =>
    wa ? `https://wa.me/${wa}?text=${encodeURIComponent(text)}` : "#";
  const steps = [
    {
      done: owner?.status === "active",
      title: "Vincular tu WhatsApp",
      sub: "Envía el código a Rocco",
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

      {sp.recuperada ? (
        <div className="notice ok">Recuperamos tu cuenta. Todo sigue como estaba.</div>
      ) : null}
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
            <span className="label">{progress.personal ? "Ingresos" : "Ventas"}</span>
            <strong className="num mint tile-n">{formatMoney(close.salesUsd, "USD")}</strong>
          </div>
          <div className="tile">
            <span className="label">Gastos</span>
            <strong className="num amber tile-n">{formatMoney(close.expensesUsd, "USD")}</strong>
          </div>
        </div>
      </section>

      {streak ? <StreakCard streak={streak} personal={progress.personal} /> : null}
      {nextReminders.length ? (
        <section className="card stack-sm">
          <div className="day">
            <h2>{es.REMINDERS_PAGE.homeTitle}</h2>
            <a className="sub" href="/recordatorios">
              {es.REMINDERS_PAGE.homeLink}
            </a>
          </div>
          <ul className="rem-home">
            {nextReminders.map((r) => (
              <li key={r.id}>
                <span>{r.text}</span>
                <span className="sub num">
                  {formatShortDate(businessDateOf(r.dueAt))} · {es.hora(r.dueAt)}
                  {r.amount ? ` · ${es.reminderAmount(r.amount, r.currency)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {accounts.length ? <Accounts list={accounts} bcv={rate.current?.value ?? null} /> : null}

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
        {close.cash ? (
          // Lo que debería haber según lo anotado en las cuentas de efectivo (PRD cash-in-drawer, C14).
          <div className="card">
            <span className="label">Debería haber en caja</span>
            <p className="kpi">
              {close.cash.usd
                ? formatMoney(close.cash.usd.balanceEnd, "USD")
                : formatMoney(close.cash.ves?.balanceEnd ?? 0, "VES")}
            </p>
            {close.cash.usd && close.cash.ves ? (
              <p className="kpi-sub num">
                {formatMoney(close.cash.ves.balanceEnd, "VES")} en bolívares
              </p>
            ) : null}
            <p className="kpi-sub num">
              Hoy: {es.cashPair(close.cash, (c, cur) => es.signedMoney(c.net, cur))}
            </p>
            <CashNote unassigned={close.unassigned} day={today} />
          </div>
        ) : progress.personal ? (
          // Una persona no tiene caja: de dónde le entró la plata este mes.
          <a className="card" href={`/movimientos?mes=${month.label}&tipo=income`}>
            <span className="label">Ingresos de {monthNameEs(today).toLowerCase()}</span>
            <p className="kpi mint">{formatMoney(monthTotals.incomeUsd, "USD")}</p>
            {sources.length ? (
              sources.slice(0, 3).map((c) => (
                <p className="kpi-sub num" key={c.id ?? "ninguna"}>
                  {c.name} {formatMoney(c.usd, "USD")}
                </p>
              ))
            ) : (
              <p className="kpi-sub">Escríbele a Rocco: me pagaron el sueldo, 300$</p>
            )}
          </a>
        ) : (
          <div className="card">
            <span className="label">Ventas en efectivo hoy</span>
            <p className="kpi">{formatMoney(close.cashSalesUsd, "USD")}</p>
            <p className="kpi-sub num">{formatMoney(close.cashSalesVes, "VES")} en bolívares</p>
          </div>
        )}
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

/** Saldo de cada cuenta y el total en dólares (los Bs a la BCV de hoy). */
function Accounts({ list, bcv }: { list: AccountView[]; bcv: Decimal | null }) {
  const nw = netWorth(list, bcv);
  return (
    <section className="card stack-sm">
      <div className="day">
        <h2>Mis cuentas</h2>
        <a className="sub" href="/ajustes/cuentas">
          Ver todas ›
        </a>
      </div>
      <div>
        <span className="label">Tienes en total</span>
        <p className="kpi num">{formatMoney(nw.totalUsd ?? nw.usd, "USD")}</p>
        <p className="kpi-sub num">
          {formatMoney(nw.usd, "USD")} en dólares · {formatMoney(nw.ves, "VES")}
        </p>
      </div>
      <div className="tight">
        {list.map((a) => (
          <a className="row" key={a.id} href={`/ajustes/cuentas/${a.id}`}>
            <span className="ico lg">
              <IconWallet />
            </span>
            <span className="what">
              <strong>{a.name}</strong>
              <span className="sub">{accountKindLine(a)}</span>
            </span>
            <span className="amts">
              <strong className={`num ${a.balance.isNegative() ? "neg" : ""}`}>
                {accountMoney(a, a.balance)}
              </strong>
            </span>
          </a>
        ))}
      </div>
    </section>
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
