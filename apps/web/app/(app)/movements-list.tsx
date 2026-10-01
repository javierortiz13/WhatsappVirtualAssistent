import { asIsoDate, Decimal, formatMoney, formatShortDate } from "@caja/core/domain";
import type { MovementRow } from "@/lib/queries";
import { IconArrowDown, IconArrowUp, IconCamera } from "./icons";

const CHANNEL: Record<string, string> = {
  text: "WhatsApp",
  voice: "nota de voz",
  image: "foto",
  dashboard: "dashboard",
};

/** Monto con signo y color fijo: gastos en ámbar con −, ventas en menta con +. */
export function Amount({ row }: { row: Pick<MovementRow, "type" | "amount" | "currency"> }) {
  const expense = row.type === "expense";
  return (
    <strong className={`num ${expense ? "amber" : "mint"}`}>
      {expense ? "−" : "+"}
      {formatMoney(row.amount, row.currency as "USD" | "VES")}
    </strong>
  );
}

/**
 * Lista agrupada por día, cada día con su neto. Una fila = icono, qué fue y cuánto; el
 * equivalente en la otra moneda va debajo del monto. Mismo formato de cifras que el bot.
 */
export function MovementsList({ rows, today }: { rows: MovementRow[]; today: string }) {
  if (rows.length === 0) return <p className="empty">Todavía no hay movimientos aquí.</p>;
  const groups = new Map<string, MovementRow[]>();
  for (const r of rows) {
    const list = groups.get(r.businessDate) ?? [];
    list.push(r);
    groups.set(r.businessDate, list);
  }
  return (
    <div>
      {[...groups.entries()].map(([date, items]) => {
        const net = items.reduce(
          (acc, m) => (m.type === "expense" ? acc.minus(m.amountUsd) : acc.plus(m.amountUsd)),
          new Decimal(0),
        );
        return (
          <section key={date}>
            <div className="day">
              <span className="label">{dayLabel(date, today)}</span>
              <span className={`sub num ${net.isNegative() ? "amber" : ""}`}>
                neto {formatMoney(net, "USD")}
              </span>
            </div>
            <div className="card tight">
              {items.map((m) => (
                <MovementRowView key={m.id} m={m} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function MovementRowView({ m }: { m: MovementRow }) {
  const expense = m.type === "expense";
  return (
    <a className="row" href={`/movimientos/${m.id}`}>
      <span className={`ico ${expense ? "amber" : "mint"}`}>
        {m.attachmentId ? (
          <IconCamera size={18} />
        ) : expense ? (
          <IconArrowDown size={18} />
        ) : (
          <IconArrowUp size={18} />
        )}
      </span>
      <span className="what">
        <strong>
          {m.description ?? (expense ? "Gasto" : "Venta")}
          {m.deletedAt ? (
            <>
              {" "}
              <span className="badge warn">eliminado</span>
            </>
          ) : null}
        </strong>
        <span className="sub">
          {expense ? (m.categoryName ?? "Otros") : "Venta"} ·{" "}
          {CHANNEL[m.sourceChannel] ?? m.sourceChannel}
        </span>
      </span>
      <span className="amts">
        <Amount row={m} />
        <span className="sub num">
          {m.currency === "USD" ? formatMoney(m.amountVes, "VES") : formatMoney(m.amountUsd, "USD")}
        </span>
      </span>
    </a>
  );
}

function dayLabel(date: string, today: string): string {
  const d = asIsoDate(date);
  const label = formatShortDate(d);
  if (date === today) return `Hoy · ${label}`;
  return label;
}
