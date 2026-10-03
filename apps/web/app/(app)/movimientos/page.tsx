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
import { IconChevronLeft, IconChevronRight, IconDownload } from "../icons";
import { MovementsList } from "../movements-list";

export const metadata: Metadata = { title: "Movimientos" };
export const dynamic = "force-dynamic";

const OK: Record<string, string> = {
  guardado: "Cambios guardados.",
  eliminado: "Movimiento eliminado. Lo puedes ver con el filtro Eliminados.",
};

const ERRORS: Record<string, string> = {
  datos: "Revisa los datos: falta algo o hay un campo que no se ve bien.",
  noexiste: "Ese movimiento ya no existe.",
};

/** Lista del mes con filtros por tipo y "Eliminados"; mes anterior y siguiente (US-E2). */
export default async function Movimientos({
  searchParams,
}: {
  searchParams: Promise<{
    mes?: string;
    tipo?: string;
    eliminados?: string;
    ok?: string;
    error?: string;
  }>;
}) {
  const { tenant } = await requireTenant();
  const sp = await searchParams;
  const today = todayInCaracas();
  // Mes 01–12: "?mes=2026-13" armaba una fecha que Postgres rechaza (500).
  const ym = /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.mes ?? "") ? (sp.mes as string) : today.slice(0, 7);
  const month = monthOf(ym);
  const filter: MovementFilter = {
    ...(sp.tipo === "expense" || sp.tipo === "income" ? { type: sp.tipo } : {}),
    ...(sp.eliminados === "1" ? { deleted: true } : {}),
  };
  const [rows, totals] = await Promise.all([
    movementsBetween(tenant.id, month.from, month.to, 500, filter),
    totalsBetween(tenant.id, month.from, month.to),
  ]);
  const net = totals.incomeUsd.minus(totals.expensesUsd);
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
      {sp.error ? (
        <div className="notice err">
          {ERRORS[sp.error] ?? "No pudimos guardar el cambio. Inténtalo de nuevo."}
        </div>
      ) : null}
      <div className="rate">
        <a className="iconbtn" href={link({ mes: shiftMonth(ym, -1) })} aria-label="Mes anterior">
          <IconChevronLeft />
        </a>
        <h2 style={{ textAlign: "center", flex: 1 }}>
          {monthNameEs(month.from)} {ym.slice(0, 4)}
        </h2>
        <a className="iconbtn" href={link({ mes: shiftMonth(ym, 1) })} aria-label="Mes siguiente">
          <IconChevronRight />
        </a>
      </div>
      <div className="card grid-3 kpis">
        <div>
          <span className="label">Ventas</span>
          <strong className="num mint">{formatMoney(totals.incomeUsd, "USD")}</strong>
        </div>
        <div>
          <span className="label">Gastos</span>
          <strong className="num amber">{formatMoney(totals.expensesUsd, "USD")}</strong>
        </div>
        <div>
          <span className="label">Neto</span>
          <strong className={`num${net.isNegative() ? " amber" : ""}`}>
            {formatMoney(net, "USD")}
          </strong>
        </div>
      </div>
      <div className="chips">
        {chip(
          "Todo",
          !filter.type && !filter.deleted,
          link({ tipo: undefined, eliminados: undefined }),
        )}
        {chip(
          "Ventas",
          filter.type === "income" && !filter.deleted,
          link({ tipo: "income", eliminados: undefined }),
        )}
        {chip(
          "Gastos",
          filter.type === "expense" && !filter.deleted,
          link({ tipo: "expense", eliminados: undefined }),
        )}
        {chip("Eliminados", !!filter.deleted, link({ tipo: undefined, eliminados: "1" }))}
        <a className="chip" href={`/exportar?desde=${month.from}&hasta=${month.to}`}>
          <IconDownload size={16} />
          Excel del mes
        </a>
      </div>
      <MovementsList rows={rows} today={today} />
    </div>
  );
}
