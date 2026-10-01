import { formatMoney, monthNameEs } from "@caja/core/domain";
import type { Metadata } from "next";
import {
  type MovementFilter,
  monthOf,
  movementsBetween,
  shiftMonth,
  todayInCaracas,
  totalsBetween,
} from "@/lib/queries";
import { requireTenant } from "@/lib/session";
import { MovementsList } from "../movements-list";

export const metadata: Metadata = { title: "Movimientos" };
export const dynamic = "force-dynamic";

const OK: Record<string, string> = {
  guardado: "Cambios guardados.",
  eliminado: "Movimiento eliminado. Lo puedes ver con el filtro Eliminados.",
};

/** Lista del mes con filtros por tipo y "Eliminados"; mes anterior y siguiente (US-E2). */
export default async function Movimientos({
  searchParams,
}: {
  searchParams: Promise<{ mes?: string; tipo?: string; eliminados?: string; ok?: string }>;
}) {
  const { tenant } = await requireTenant();
  const sp = await searchParams;
  const today = todayInCaracas();
  const ym = /^\d{4}-\d{2}$/.test(sp.mes ?? "") ? (sp.mes as string) : today.slice(0, 7);
  const month = monthOf(ym);
  const filter: MovementFilter = {
    ...(sp.tipo === "expense" || sp.tipo === "income" ? { type: sp.tipo } : {}),
    ...(sp.eliminados === "1" ? { deleted: true } : {}),
  };
  const [rows, totals] = await Promise.all([
    movementsBetween(tenant.id, month.from, month.to, 500, filter),
    totalsBetween(tenant.id, month.from, month.to),
  ]);
  const link = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    const merged = { mes: ym, tipo: sp.tipo, eliminados: sp.eliminados, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) q.set(k, v);
    return `/movimientos?${q.toString()}`;
  };
  const chip = (label: string, active: boolean, href: string) => (
    <a className={`chip${active ? " active" : ""}`} href={href}>
      {label}
    </a>
  );
  return (
    <div className="stack">
      {sp.ok && OK[sp.ok] ? <div className="notice ok">{OK[sp.ok]}</div> : null}
      <div className="card rate">
        <a
          className="btn secondary small"
          href={link({ mes: shiftMonth(ym, -1) })}
          aria-label="Mes anterior"
        >
          ‹
        </a>
        <div style={{ textAlign: "center" }}>
          <p className="kpi-label" style={{ margin: 0 }}>
            {monthNameEs(month.from)} {ym.slice(0, 4)}
          </p>
          <p className="kpi-sub">
            ventas {formatMoney(totals.incomeUsd, "USD")} · gastos{" "}
            {formatMoney(totals.expensesUsd, "USD")} · neto{" "}
            <strong>{formatMoney(totals.incomeUsd.minus(totals.expensesUsd), "USD")}</strong>
          </p>
        </div>
        <a
          className="btn secondary small"
          href={link({ mes: shiftMonth(ym, 1) })}
          aria-label="Mes siguiente"
        >
          ›
        </a>
      </div>
      <div className="chips">
        {chip(
          "Todo",
          !filter.type && !filter.deleted,
          link({ tipo: undefined, eliminados: undefined }),
        )}
        {chip(
          "Gastos",
          filter.type === "expense" && !filter.deleted,
          link({ tipo: "expense", eliminados: undefined }),
        )}
        {chip(
          "Ventas",
          filter.type === "income" && !filter.deleted,
          link({ tipo: "income", eliminados: undefined }),
        )}
        {chip("Eliminados", !!filter.deleted, link({ tipo: undefined, eliminados: "1" }))}
        <a className="chip" href={`/exportar?desde=${month.from}&hasta=${month.to}`}>
          ⬇ Excel del mes
        </a>
      </div>
      <MovementsList rows={rows} today={today} />
    </div>
  );
}
