import { addDays } from "@caja/core/domain";
import type { Metadata } from "next";
import { monthBounds, todayInCaracas } from "@/lib/queries";
import { requireTenant } from "@/lib/session";
import { IconCalendar, IconChevronLeft, IconDownload } from "../../icons";

export const metadata: Metadata = { title: "Exportar" };
export const dynamic = "force-dynamic";

/** Exportar a Excel (US-E3): un .xlsx por rango de fechas, máximo 12 meses. */
export default async function Exportar() {
  await requireTenant();
  const today = todayInCaracas();
  const month = monthBounds(today);
  const quick = [
    { label: "Este mes", from: month.from, to: today },
    { label: "Últimos 30 días", from: addDays(today, -29), to: today },
    { label: "Últimos 90 días", from: addDays(today, -89), to: today },
  ];
  return (
    <div className="stack">
      <div className="rate">
        <a className="iconbtn" href="/ajustes" aria-label="Volver a ajustes">
          <IconChevronLeft />
        </a>
        <span className="sub">Ajustes</span>
      </div>
      <form className="card stack" action="/exportar" method="get">
        <h2>Exportar a Excel</h2>
        <p className="sub" style={{ margin: 0 }}>
          Una fila por movimiento: fecha, tipo, categoría, descripción, monto, moneda, tasa,
          equivalentes, método, autor y canal. Hasta 12 meses por archivo.
        </p>
        <div className="grid-2">
          <label className="field">
            <span>Desde</span>
            <span className="sel">
              <input
                className="input"
                type="date"
                name="desde"
                defaultValue={month.from}
                required
              />
              <IconCalendar className="cal" size={18} />
            </span>
          </label>
          <label className="field">
            <span>Hasta</span>
            <span className="sel">
              <input className="input" type="date" name="hasta" defaultValue={today} required />
              <IconCalendar className="cal" size={18} />
            </span>
          </label>
        </div>
        <div className="center">
          <button className="btn" type="submit">
            <IconDownload size={18} />
            Descargar .xlsx
          </button>
        </div>
      </form>
      <div className="chips" style={{ justifyContent: "center" }}>
        {quick.map((q) => (
          <a className="chip" key={q.label} href={`/exportar?desde=${q.from}&hasta=${q.to}`}>
            {q.label}
          </a>
        ))}
      </div>
    </div>
  );
}
