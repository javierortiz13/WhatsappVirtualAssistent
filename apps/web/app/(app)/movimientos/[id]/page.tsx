import { PAYMENT_METHOD_LABELS, type PaymentMethod } from "@caja/core";
import { asIsoDate, formatMoney, formatShortDate } from "@caja/core/domain";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { categoriesOf, movementById } from "@/lib/queries";
import { requireTenant } from "@/lib/session";
import { deleteMovementAction, updateMovementAction } from "./actions";

export const metadata: Metadata = { title: "Movimiento" };
export const dynamic = "force-dynamic";

const CHANNEL: Record<string, string> = {
  text: "WhatsApp ✍",
  voice: "WhatsApp 🎤",
  image: "WhatsApp 📷",
  dashboard: "dashboard",
};
const MSG: Record<string, string> = {
  guardado: "Cambios guardados.",
  tasa: "Cambios guardados. Como cambió la fecha, se recalculó con la tasa de ese día.",
  igual: "No había nada que cambiar.",
  monto: "El monto no se ve bien. Usa números, por ejemplo 15.50.",
  fecha: "La fecha no se ve bien.",
  datos: "Revisa los datos del formulario.",
};

/** Detalle y edición de un movimiento (US-E2). Un movimiento eliminado se ve pero no se edita. */
export default async function Movimiento({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { tenant } = await requireTenant();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [m, categories] = await Promise.all([movementById(tenant.id, id), categoriesOf(tenant.id)]);
  if (!m) notFound();
  const isExpense = m.type === "expense";
  const notice = sp.ok ? MSG[sp.ok] : sp.error ? MSG[sp.error] : null;
  const fmt = (d: Date) =>
    `${formatShortDate(asIsoDate(d.toISOString().slice(0, 10)))} ${d.toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit", timeZone: "America/Caracas" })}`;
  return (
    <div className="stack">
      <p style={{ margin: 0 }}>
        <a href={`/movimientos?mes=${m.businessDate.slice(0, 7)}`}>← Movimientos</a>
      </p>
      {notice ? <div className={`notice ${sp.error ? "err" : "ok"}`}>{notice}</div> : null}
      {m.deletedAt ? (
        <div className="notice err">Este movimiento fue eliminado el {fmt(m.deletedAt)}.</div>
      ) : null}
      <form action={updateMovementAction} className="card stack">
        <input type="hidden" name="id" value={m.id} />
        <h2 style={{ margin: 0 }}>{isExpense ? "Gasto" : "Venta"}</h2>
        <div className="grid-2">
          <label className="field">
            <span>Monto</span>
            <input
              className="input"
              name="amount"
              type="number"
              step="0.01"
              min="0.01"
              inputMode="decimal"
              defaultValue={m.amount}
              required
              disabled={!!m.deletedAt}
            />
          </label>
          <label className="field">
            <span>Moneda</span>
            <select
              className="input"
              name="currency"
              defaultValue={m.currency}
              disabled={!!m.deletedAt}
            >
              <option value="USD">USD</option>
              <option value="VES">Bs</option>
            </select>
          </label>
        </div>
        <p className="kpi-sub" style={{ marginTop: -8 }}>
          ={" "}
          {m.currency === "USD" ? formatMoney(m.amountVes, "VES") : formatMoney(m.amountUsd, "USD")}{" "}
          a tasa {formatMoney(m.rateValue, "VES").replace("Bs ", "")}
          {m.rateSource === "manual" ? " (manual)" : ""}
        </p>
        <label className="field">
          <span>Fecha</span>
          <input
            className="input"
            name="business_date"
            type="date"
            defaultValue={m.businessDate}
            required
            disabled={!!m.deletedAt}
          />
        </label>
        <p className="muted" style={{ margin: "-8px 0 0", fontSize: 13 }}>
          Si cambias la fecha, se recalcula con la tasa BCV de ese día.
        </p>
        {isExpense ? (
          <label className="field">
            <span>Categoría</span>
            <select
              className="input"
              name="category_id"
              defaultValue={m.categoryId ?? ""}
              disabled={!!m.deletedAt}
            >
              <option value="">Otros</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="field">
            <span>Método de pago</span>
            <select
              className="input"
              name="payment_method"
              defaultValue={m.paymentMethod}
              disabled={!!m.deletedAt}
            >
              {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((k) => (
                <option key={k} value={k}>
                  {PAYMENT_METHOD_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>Descripción</span>
          <input
            className="input"
            name="description"
            maxLength={200}
            defaultValue={m.description ?? ""}
            disabled={!!m.deletedAt}
          />
        </label>
        {m.attachmentId ? (
          <p style={{ margin: 0 }}>
            <span className="kpi-label">Factura</span>
            <a href={`/adjuntos/${m.attachmentId}`} target="_blank" rel="noreferrer">
              Ver foto
            </a>
          </p>
        ) : null}
        <div>
          <p className="kpi-label">Registrado por {CHANNEL[m.sourceChannel] ?? m.sourceChannel}</p>
          <p style={{ margin: 0, fontSize: 14 }}>
            {m.author} · {fmt(m.createdAt)}
          </p>
          {m.sourceBody && m.sourceChannel !== "dashboard" ? (
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
              "{m.sourceBody.slice(0, 200)}"
            </p>
          ) : null}
          <p className="kpi-sub">
            {m.updatedAt.getTime() - m.createdAt.getTime() > 1000
              ? `Editado ${fmt(m.updatedAt)}`
              : "Editado: nunca"}
            {m.origin === "day_total" ? " · parte de la venta del día" : ""}
          </p>
        </div>
        {!m.deletedAt ? (
          <button className="btn" type="submit">
            Guardar
          </button>
        ) : null}
      </form>
      {!m.deletedAt ? (
        <form action={deleteMovementAction}>
          <input type="hidden" name="id" value={m.id} />
          <button className="btn danger" type="submit" onClick={undefined}>
            Eliminar {isExpense ? "gasto" : "venta"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
