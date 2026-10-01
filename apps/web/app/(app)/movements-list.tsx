import { asIsoDate, formatMoney, formatShortDate } from "@caja/core/domain";
import type { MovementRow } from "@/lib/queries";

const CHANNEL: Record<string, string> = {
  text: "WhatsApp",
  voice: "nota de voz",
  image: "foto",
  dashboard: "dashboard",
};

/** Lista agrupada por día. Mismo formato de cifras que el bot. */
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
      {[...groups.entries()].map(([date, items]) => (
        <section key={date}>
          <p className="day">{dayLabel(date, today)}</p>
          <ul className="list card" style={{ padding: "0 var(--space-4)" }}>
            {items.map((m) => (
              <li key={m.id} className={m.type}>
                <span className="title">{m.description ?? "Sin descripción"}</span>
                <span className="amt">
                  {m.type === "expense" ? "−" : "+"}
                  {formatMoney(m.amount, m.currency as "USD" | "VES")}
                </span>
                <span className="meta">
                  {m.categoryName ?? "Otros"} · {CHANNEL[m.sourceChannel] ?? m.sourceChannel}
                  {m.attachmentId ? (
                    <>
                      {" · "}
                      <a href={`/adjuntos/${m.attachmentId}`} target="_blank" rel="noreferrer">
                        ver foto
                      </a>
                    </>
                  ) : null}
                </span>
                <span className="amt2">
                  {m.currency === "USD"
                    ? formatMoney(m.amountVes, "VES")
                    : formatMoney(m.amountUsd, "USD")}{" "}
                  · tasa {formatMoney(m.rateValue, "VES").replace("Bs ", "")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function dayLabel(date: string, today: string): string {
  const d = asIsoDate(date);
  const label = formatShortDate(d);
  if (date === today) return `Hoy, ${label}`;
  return label;
}
