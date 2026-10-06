import { listAccounts, PAYMENT_METHOD_LABELS, type PaymentMethod } from "@caja/core";
import { businessDateOf, formatMoney, formatShortDate } from "@caja/core/domain";
import { withTenant } from "@caja/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { categoriesOf, movementById } from "@/lib/queries";
import { requireTenant } from "@/lib/session";
import {
  IconArrowDown,
  IconArrowUp,
  IconCalendar,
  IconCamera,
  IconChevronDown,
  IconChevronLeft,
  IconFile,
} from "../../icons";
import { deleteMovementAction, updateMovementAction } from "./actions";

export const metadata: Metadata = { title: "Movimiento" };
export const dynamic = "force-dynamic";

const CHANNEL: Record<string, string> = {
  text: "por WhatsApp",
  voice: "por nota de voz",
  image: "por foto",
  dashboard: "desde el dashboard",
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
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const [m, categories, accounts] = await Promise.all([
    movementById(tenant.id, id),
    categoriesOf(tenant.id),
    withTenant(db(), tenant.id, (tx) => listAccounts(tx, tenant.id)),
  ]);
  if (!m) notFound();
  const isExpense = m.type === "expense";
  const locked = !!m.deletedAt;
  const notice = sp.ok ? MSG[sp.ok] : sp.error ? MSG[sp.error] : null;
  const amountText = `${isExpense ? "−" : "+"}${formatMoney(m.amount, m.currency as "USD" | "VES")}`;
  // Fecha y hora en Caracas: la fecha UTC daba "mañana" a todo lo hecho después de las 20:00.
  const fmt = (d: Date) =>
    `${formatShortDate(businessDateOf(d))} ${d.toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit", timeZone: "America/Caracas" })}`;
  return (
    <div className="stack">
      <div className="rate">
        <a
          className="iconbtn"
          href={`/movimientos?mes=${m.businessDate.slice(0, 7)}`}
          aria-label="Volver a movimientos"
        >
          <IconChevronLeft />
        </a>
        <span className={`tag ${isExpense ? "expense" : "income"}`}>
          {isExpense ? <IconArrowDown size={14} /> : <IconArrowUp size={14} />}
          {isExpense ? "Gasto" : "Venta"}
        </span>
        <span style={{ flex: 1 }} />
        {m.deletedAt ? <span className="badge warn">eliminado</span> : null}
      </div>
      {notice ? <div className={`notice ${sp.error ? "err" : "ok"}`}>{notice}</div> : null}
      {m.deletedAt ? (
        <div className="notice err">Este movimiento fue eliminado el {fmt(m.deletedAt)}.</div>
      ) : null}

      <section className="card center-text">
        <span className="label">{m.description ?? (isExpense ? "Gasto" : "Venta")}</span>
        <p
          className={`big num ${isExpense ? "amber" : "mint"}${amountText.length > 12 ? " long" : ""}`}
        >
          {amountText}
        </p>
        <p className="sub num">
          {m.currency === "USD" ? formatMoney(m.amountVes, "VES") : formatMoney(m.amountUsd, "USD")}{" "}
          · tasa {m.rateSource === "bcv_eur" ? "euro " : ""}
          {m.rateSource === "exchange" ? "de tu cambio " : ""}
          {formatMoney(m.rateValue, "VES").replace("Bs ", "")}
          {m.rateSource === "manual" ? " (manual)" : ""}
        </p>
      </section>

      <form action={updateMovementAction} className="card stack">
        <input type="hidden" name="id" value={m.id} />
        <div className="grid-2">
          <label className="field">
            <span>Monto</span>
            <input
              className="input center num"
              name="amount"
              type="number"
              step="0.01"
              min="0.01"
              inputMode="decimal"
              defaultValue={m.amount}
              required
              disabled={locked}
            />
          </label>
          <label className="field">
            <span>Moneda</span>
            <span className="sel">
              <select className="input" name="currency" defaultValue={m.currency} disabled={locked}>
                <option value="USD">USD</option>
                <option value="VES">Bs</option>
              </select>
              <IconChevronDown size={16} />
            </span>
          </label>
        </div>
        <label className="field">
          <span>Fecha</span>
          <span className="sel">
            <input
              className="input"
              name="business_date"
              type="date"
              defaultValue={m.businessDate}
              required
              disabled={locked}
            />
            <IconCalendar className="cal" size={18} />
          </span>
          <span className="hint">
            {m.rateSource === "exchange"
              ? "Sale de tus cambios USDT: si cambias el monto, se recalcula con lo que queda en ellos."
              : "Si cambias la fecha, se recalcula con la tasa BCV de ese día."}
          </span>
        </label>
        {isExpense ? (
          <label className="field">
            <span>Categoría</span>
            <span className="sel">
              <select
                className="input"
                name="category_id"
                defaultValue={m.categoryId ?? ""}
                disabled={locked}
              >
                <option value="">Otros</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                {/* Categoría desactivada: sigue como opción para que editar otro campo no la borre. */}
                {m.categoryId && !categories.some((c) => c.id === m.categoryId) ? (
                  <option value={m.categoryId}>{m.categoryName ?? "Categoría desactivada"}</option>
                ) : null}
              </select>
              <IconChevronDown size={16} />
            </span>
          </label>
        ) : (
          <label className="field">
            <span>Método de pago</span>
            <span className="sel">
              <select
                className="input"
                name="payment_method"
                defaultValue={m.paymentMethod}
                disabled={locked}
              >
                {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((k) => (
                  <option key={k} value={k}>
                    {PAYMENT_METHOD_LABELS[k]}
                  </option>
                ))}
              </select>
              <IconChevronDown size={16} />
            </span>
          </label>
        )}
        {accounts.length || m.accountId ? (
          <label className="field">
            <span>{isExpense ? "Salió de la cuenta" : "Entró a la cuenta"}</span>
            <span className="sel">
              <select
                className="input"
                name="account_id"
                defaultValue={m.accountId ?? ""}
                disabled={locked}
              >
                <option value="">Sin cuenta</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
                {/* Cuenta archivada: sigue como opción para que editar otro campo no la quite. */}
                {m.accountId && !accounts.some((a) => a.id === m.accountId) ? (
                  <option value={m.accountId}>{m.accountName ?? "Cuenta archivada"}</option>
                ) : null}
              </select>
              <IconChevronDown size={16} />
            </span>
          </label>
        ) : null}
        <label className="field">
          <span>Descripción</span>
          <input
            className="input center"
            name="description"
            maxLength={200}
            defaultValue={m.description ?? ""}
            disabled={locked}
          />
        </label>
        {!locked ? (
          <div className="center">
            <button className="btn" type="submit">
              Guardar
            </button>
          </div>
        ) : null}
      </form>

      <section className="card">
        <div className="row" style={{ padding: 0 }}>
          <span className="avatar">{m.author.charAt(0).toUpperCase()}</span>
          <span className="what">
            <strong>{m.author}</strong>
            <span className="sub">
              {m.attachmentMime === "application/pdf"
                ? "por PDF"
                : (CHANNEL[m.sourceChannel] ?? m.sourceChannel)}{" "}
              · {fmt(m.createdAt)}
            </span>
          </span>
          {m.attachmentId && m.attachmentDeletedAt ? (
            <span className="sub">Foto borrada (se guardan 12 meses)</span>
          ) : m.attachmentId ? (
            <a
              className="btn secondary small"
              href={`/adjuntos/${m.attachmentId}`}
              target="_blank"
              rel="noreferrer"
            >
              {m.attachmentMime === "application/pdf" ? (
                <>
                  <IconFile size={16} />
                  PDF
                </>
              ) : (
                <>
                  <IconCamera size={16} />
                  Foto
                </>
              )}
            </a>
          ) : null}
        </div>
        {m.sourceBody && m.sourceChannel !== "dashboard" ? (
          <p className="sub quote">"{m.sourceBody.slice(0, 200)}"</p>
        ) : null}
        <p className="sub" style={{ margin: "var(--space-2) 0 0" }}>
          {m.updatedAt.getTime() - m.createdAt.getTime() > 1000
            ? `Editado ${fmt(m.updatedAt)}`
            : "Sin ediciones"}
          {m.origin === "day_total" ? " · parte de la venta del día" : ""}
        </p>
      </section>

      {!locked ? (
        <form action={deleteMovementAction} className="center">
          <input type="hidden" name="id" value={m.id} />
          <button className="btn danger" type="submit">
            Eliminar {isExpense ? "gasto" : "venta"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
