import { expensesByCategory } from "@caja/core";
import { formatMoney, monthNameEs } from "@caja/core/domain";
import { and, eq, schema, withTenant } from "@caja/db";
import type { Metadata } from "next";
import { db } from "@/lib/db";
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lista del mes con filtros por tipo y "Eliminados"; mes anterior y siguiente (US-E2). En Gastos,
 * el total por categoría; tocar una (`?categoria=`) lista solo sus gastos del mes.
 */
export default async function Movimientos({
  searchParams,
}: {
  searchParams: Promise<{
    mes?: string;
    tipo?: string;
    eliminados?: string;
    categoria?: string;
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
  // Gastos de una categoría (un id, o "ninguna" para los sin categoría): solo gastos.
  const categoryId =
    sp.categoria === "ninguna"
      ? null
      : UUID.test(sp.categoria ?? "")
        ? (sp.categoria as string)
        : undefined;
  const filter: MovementFilter = {
    ...(categoryId !== undefined
      ? { type: "expense" as const, categoryId }
      : sp.tipo === "expense" || sp.tipo === "income"
        ? { type: sp.tipo }
        : {}),
    ...(sp.eliminados === "1" ? { deleted: true } : {}),
  };
  const [rows, totals, byCategory, categoryName] = await Promise.all([
    movementsBetween(tenant.id, month.from, month.to, 500, filter),
    totalsBetween(tenant.id, month.from, month.to),
    filter.type === "expense" && !filter.deleted
      ? withTenant(db(), tenant.id, (tx) => expensesByCategory(tx, tenant.id, month.from, month.to))
      : Promise.resolve([]),
    categoryId
      ? withTenant(db(), tenant.id, async (tx) => {
          const [c] = await tx
            .select({ name: schema.category.name })
            .from(schema.category)
            .where(
              and(eq(schema.category.tenantId, tenant.id), eq(schema.category.id, categoryId)),
            );
          return c?.name ?? null;
        })
      : Promise.resolve(categoryId === null ? "Otros (sin categoría)" : null),
  ]);
  const shown = categoryId !== undefined ? byCategory.find((c) => c.id === categoryId) : undefined;
  const net = totals.incomeUsd.minus(totals.expensesUsd);
  const link = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    const merged = {
      mes: ym,
      tipo: sp.tipo,
      eliminados: sp.eliminados,
      categoria: sp.categoria,
      ...over,
    };
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
          link({ tipo: undefined, eliminados: undefined, categoria: undefined }),
        )}
        {chip(
          "Ventas",
          filter.type === "income" && !filter.deleted,
          link({ tipo: "income", eliminados: undefined, categoria: undefined }),
        )}
        {chip(
          "Gastos",
          filter.type === "expense" && !filter.deleted && categoryId === undefined,
          link({ tipo: "expense", eliminados: undefined, categoria: undefined }),
        )}
        {chip(
          "Eliminados",
          !!filter.deleted,
          link({ tipo: undefined, eliminados: "1", categoria: undefined }),
        )}
        <a className="chip" href={`/exportar?desde=${month.from}&hasta=${month.to}`}>
          <IconDownload size={16} />
          Excel del mes
        </a>
      </div>
      {categoryId !== undefined && !filter.deleted ? (
        // Gastos de una categoría en el mes: el total y la lista de abajo.
        <div className="card rate">
          <div>
            <span className="label">Categoría</span>
            <strong>{categoryName ?? "Categoría"}</strong>
            <p className="kpi-sub num">
              {formatMoney(shown?.usd ?? 0, "USD")} en{" "}
              {shown?.count === 1 ? "1 gasto" : `${shown?.count ?? 0} gastos`} en{" "}
              {monthNameEs(month.from).toLowerCase()}
            </p>
          </div>
          <a className="chip" href={link({ tipo: "expense", categoria: undefined })}>
            Todas ›
          </a>
        </div>
      ) : byCategory.length ? (
        // Gastos del mes por categoría: tocar una muestra sus gastos.
        <section className="card">
          <span className="label">Por categoría</span>
          {byCategory.map((c) => (
            <a
              className="line"
              key={c.id ?? "ninguna"}
              href={link({ categoria: c.id ?? "ninguna" })}
            >
              <span>
                {c.name}{" "}
                <span className="muted">· {c.count === 1 ? "1 gasto" : `${c.count} gastos`}</span>
              </span>
              <span className="num">{formatMoney(c.usd, "USD")} ›</span>
            </a>
          ))}
        </section>
      ) : null}
      <MovementsList rows={rows} today={today} />
    </div>
  );
}
