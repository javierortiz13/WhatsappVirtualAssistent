import {
  dailyClose,
  PAYMENT_METHOD_LABELS,
  type PaymentMethod,
  periodSummary,
  resolvePeriod,
} from "@caja/core";
import {
  addDays,
  Decimal,
  formatMoney,
  formatShortDate,
  type IsoDate,
  isIsoDate,
  monthNameEs,
  weekday,
} from "@caja/core/domain";
import { withTenant } from "@caja/db";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { dailyNets, todayInCaracas } from "@/lib/queries";
import { requireTenant } from "@/lib/session";
import { IconCalendar, IconDownload } from "../icons";

export const metadata: Metadata = { title: "Cierres" };
export const dynamic = "force-dynamic";

type Periodo = "dia" | "semana" | "mes" | "rango";
const SEG: { key: Periodo; label: string }[] = [
  { key: "dia", label: "Día" },
  { key: "semana", label: "Semana" },
  { key: "mes", label: "Mes" },
  { key: "rango", label: "Rango" },
];
const DAYS = ["D", "L", "M", "M", "J", "V", "S"];

/**
 * Cierre del día, de la semana, del mes o de un rango (US-D1..D3): mismas funciones que el bot.
 * Arriba el neto y las barras de los últimos 7 días; abajo ventas por método y gastos por categoría.
 */
export default async function Cierres({
  searchParams,
}: {
  searchParams: Promise<{ periodo?: string; desde?: string; hasta?: string }>;
}) {
  const { tenant } = await requireTenant();
  const sp = await searchParams;
  const today = todayInCaracas();
  const periodo: Periodo = (SEG.find((s) => s.key === sp.periodo)?.key ?? "dia") as Periodo;
  const custom = {
    from: isIsoDate(sp.desde ?? "") ? (sp.desde as IsoDate) : null,
    to: isIsoDate(sp.hasta ?? "") ? (sp.hasta as IsoDate) : null,
  };
  const range =
    periodo === "dia"
      ? { from: today, to: today }
      : periodo === "semana"
        ? resolvePeriod("this_week", today)
        : periodo === "mes"
          ? resolvePeriod("this_month", today)
          : resolvePeriod("custom", today, custom);
  const ok = !("error" in range);
  const weekFrom = addDays(today, -6);
  const [close, summary, nets] = await Promise.all([
    withTenant(db(), tenant.id, (tx) => dailyClose(tx, tenant.id, ok ? range.to : today)),
    ok
      ? withTenant(db(), tenant.id, (tx) => periodSummary(tx, tenant.id, range.from, range.to))
      : null,
    dailyNets(tenant.id, weekFrom, today),
  ]);
  const title = !ok
    ? "Elige un rango"
    : periodo === "dia"
      ? `Hoy · ${formatShortDate(today)}`
      : periodo === "semana"
        ? `Esta semana · desde ${formatShortDate(range.from)}`
        : periodo === "mes"
          ? `${monthNameEs(today)} · hasta hoy`
          : `${formatShortDate(range.from)} → ${formatShortDate(range.to)}`;
  const net = periodo === "dia" ? close.netUsd : (summary?.netUsd ?? new Decimal(0));
  const sales = periodo === "dia" ? close.salesUsd : (summary?.salesUsd ?? new Decimal(0));
  const expenses = periodo === "dia" ? close.expensesUsd : (summary?.expensesUsd ?? new Decimal(0));

  return (
    <div className="stack">
      <nav className="seg" aria-label="Período">
        {SEG.map((s) => (
          <a
            key={s.key}
            href={`/cierres?periodo=${s.key}`}
            aria-current={periodo === s.key ? "page" : undefined}
          >
            {s.label}
          </a>
        ))}
      </nav>
      {periodo === "rango" ? (
        <form className="card grid-2" method="get" action="/cierres">
          <input type="hidden" name="periodo" value="rango" />
          <label className="field">
            <span>Desde</span>
            <span className="sel">
              <input
                className="input"
                type="date"
                name="desde"
                defaultValue={custom.from ?? ""}
                required
              />
              <IconCalendar className="cal" size={18} />
            </span>
          </label>
          <label className="field">
            <span>Hasta</span>
            <span className="sel">
              <input
                className="input"
                type="date"
                name="hasta"
                defaultValue={custom.to ?? today}
                required
              />
              <IconCalendar className="cal" size={18} />
            </span>
          </label>
          <div className="center" style={{ gridColumn: "1 / -1" }}>
            <button className="btn secondary small" type="submit">
              Ver cierre
            </button>
          </div>
          {"error" in range && custom.from && custom.to ? (
            <p className="sub" style={{ gridColumn: "1 / -1", margin: 0, textAlign: "center" }}>
              {range.error === "inverted"
                ? "La fecha inicial es posterior a la final."
                : "Máximo 12 meses por cierre."}
            </p>
          ) : null}
        </form>
      ) : null}

      {!ok ? null : (
        <>
          <section className="card hero">
            <span className="label">{title}</span>
            <p className={`big num ${net.isNegative() ? "amber" : "mint"}`}>
              {formatMoney(net, "USD")}
            </p>
            <p className="sub num">
              {close.rateValue !== null
                ? `${formatMoney(net.mul(close.rateValue).toDecimalPlaces(2, Decimal.ROUND_HALF_UP), "VES")} · tasa ${formatMoney(close.rateValue, "VES").replace("Bs ", "")}`
                : "sin tasa del día"}
            </p>
            <Bars nets={nets} from={weekFrom} today={today} />
            <span className="cap">Neto de los últimos 7 días</span>
          </section>

          <div className="grid-2 stack-sm">
            <section className="card">
              <span className="label">Ventas</span>
              <p className="kpi mint">{formatMoney(sales, "USD")}</p>
              {periodo === "dia" ? (
                <div style={{ marginTop: "var(--space-2)" }}>
                  {close.salesByMethod.length === 0 ? (
                    <p className="sub" style={{ margin: 0 }}>
                      sin ventas
                    </p>
                  ) : (
                    close.salesByMethod.map((x) => (
                      <div className="line" key={x.method}>
                        <span className="muted">
                          {PAYMENT_METHOD_LABELS[x.method as PaymentMethod]}
                        </span>
                        <span className="num">{formatMoney(x.usd, "USD")}</span>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <p className="kpi-sub">
                  {summary?.daysWithMovements === 1
                    ? "1 día con movimientos"
                    : `${summary?.daysWithMovements ?? 0} días con movimientos`}
                </p>
              )}
            </section>
            <section className="card">
              <span className="label">Gastos</span>
              <p className="kpi amber">{formatMoney(expenses, "USD")}</p>
              <div style={{ marginTop: "var(--space-2)" }}>
                {(periodo === "dia" ? close.expensesByCategory : (summary?.topExpenses ?? []))
                  .length === 0 ? (
                  <p className="sub" style={{ margin: 0 }}>
                    sin gastos
                  </p>
                ) : (
                  (periodo === "dia" ? close.expensesByCategory : (summary?.topExpenses ?? [])).map(
                    (c) => (
                      <div className="line" key={c.name}>
                        <span className="muted">{c.name}</span>
                        <span className="num">{formatMoney(c.usd, "USD")}</span>
                      </div>
                    ),
                  )
                )}
              </div>
            </section>
          </div>

          {periodo === "dia" ? (
            <section className="card rate">
              <div>
                <span className="label">Efectivo en caja</span>
                <p className="kpi">{formatMoney(close.cashUsd, "USD")}</p>
              </div>
              <div style={{ textAlign: "right" }}>
                <span className="label">En bolívares</span>
                <p className="kpi num" style={{ fontSize: 20 }}>
                  {formatMoney(close.cashVes, "VES")}
                </p>
              </div>
            </section>
          ) : null}

          <div className="center">
            <a className="btn" href={`/exportar?desde=${range.from}&hasta=${range.to}`}>
              <IconDownload size={18} />
              Exportar a Excel
            </a>
          </div>
        </>
      )}
    </div>
  );
}

/** Siete barras: el mejor día en menta, el peor en ámbar, hoy con degradado. Alto relativo al mayor |neto|. */
function Bars({
  nets,
  from,
  today,
}: {
  nets: { date: string; net: Decimal }[];
  from: IsoDate;
  today: IsoDate;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const byDate = new Map(nets.map((n) => [n.date, n.net]));
  const values = days.map((d) => byDate.get(d) ?? new Decimal(0));
  const max = values.reduce((m, v) => (v.abs().gt(m) ? v.abs() : m), new Decimal(0));
  const withData = values.filter((v) => !v.isZero());
  const best = withData.length ? values.findIndex((v) => v.eq(Decimal.max(...withData))) : -1;
  const worst = withData.length > 1 ? values.findIndex((v) => v.eq(Decimal.min(...withData))) : -1;
  return (
    <div className="bars" role="img" aria-label="Neto de los últimos 7 días">
      {days.map((d, i) => {
        const v = values[i] as Decimal;
        const h = max.isZero() ? 0 : Math.max(6, v.abs().div(max).mul(72).toNumber());
        const cls = ["bar"];
        if (d === today) cls.push("today");
        else if (i === best && best !== worst) cls.push("best");
        else if (i === worst) cls.push("worst");
        return (
          <span
            className={cls.join(" ")}
            key={d}
            title={`${formatShortDate(d)}: ${formatMoney(v, "USD")}`}
          >
            <i style={{ height: h }} />
            <b>{DAYS[weekday(d)]}</b>
          </span>
        );
      })}
    </div>
  );
}
