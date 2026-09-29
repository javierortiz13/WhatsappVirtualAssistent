import { formatMoney, monthNameEs } from "@caja/core/domain";
import type { Metadata } from "next";
import { monthBounds, movementsBetween, todayInCaracas, totalsBetween } from "@/lib/queries";
import { requireTenant } from "@/lib/session";
import { MovementsList } from "../movements-list";

export const metadata: Metadata = { title: "Movimientos" };
export const dynamic = "force-dynamic";

export default async function Movimientos() {
  const { tenant } = await requireTenant();
  const today = todayInCaracas();
  const month = monthBounds(today);
  const [rows, totals] = await Promise.all([
    movementsBetween(tenant.id, month.from, month.to),
    totalsBetween(tenant.id, month.from, month.to),
  ]);
  return (
    <div className="stack">
      <div className="card rate">
        <div>
          <p className="kpi-label">{monthNameEs(today)}</p>
          <p className="kpi-sub">
            ventas {formatMoney(totals.incomeUsd, "USD")} · gastos{" "}
            {formatMoney(totals.expensesUsd, "USD")}
          </p>
        </div>
        <strong>{formatMoney(totals.incomeUsd.minus(totals.expensesUsd), "USD")}</strong>
      </div>
      <MovementsList rows={rows} today={today} />
    </div>
  );
}
