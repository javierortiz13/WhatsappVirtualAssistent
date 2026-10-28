import {
  businessDateOf,
  type DashboardReminder,
  dashboardReminders,
  es,
  formatShortDate,
  habitSettings,
} from "@caja/core";
import { withTenant } from "@caja/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { adminEmails } from "@/lib/admin";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";
import { IconClock } from "../icons";
import { deleteReminderAction, editReminderAction, markDoneAction } from "./actions";

export const metadata: Metadata = { title: "Recordatorios" };
export const dynamic = "force-dynamic";

const T = es.REMINDERS_PAGE;

const MSG: Record<string, string> = {
  hecho: "Listo, quedó como hecho.",
  borrado: "Recordatorio borrado.",
  editado: "Recordatorio guardado.",
  permiso: "Solo el dueño puede cambiar los recordatorios.",
  invalid: "No se pudo guardar. Revisa los datos.",
  monto: "No entendí el monto. Escríbelo como 20 o 20,50.",
  fecha: "Esa fecha y hora ya pasaron o están a más de un año.",
};

/** «vie 13/11 · 9 am», en hora de Caracas. */
function cuando(at: Date): string {
  return `${formatShortDate(businessDateOf(at))} · ${es.hora(at)}`;
}

/** Fecha y hora de Caracas para los campos del formulario. */
function localParts(at: Date): { date: string; time: string } {
  const iso = new Date(at.getTime() - 4 * 3_600_000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/**
 * Recordatorios (PRD hábitos US-309, textos H32): los pendientes con Marcar como hecho, Editar y
 * Borrar, y los hechos y vencidos de los últimos 30 días. Solo el dueño, y solo con el interruptor
 * `habits.reminders` encendido (o un administrador, para revisarla). Horas de Caracas.
 */
export default async function Recordatorios({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { tenant, user } = await requireTenant();
  // Con el interruptor apagado, solo los administradores la ven (para revisarla antes de encender).
  if (
    !(await habitSettings(db())).reminders &&
    !adminEmails().includes(user.email.toLowerCase())
  )
    notFound();
  const sp = await searchParams;
  const notice = sp.ok ? MSG[sp.ok] : sp.error ? MSG[sp.error] : null;
  if (tenant.role !== "owner")
    return (
      <div className="stack">
        <p className="sub">Los recordatorios son para el dueño de la cuenta.</p>
      </div>
    );
  const { pending, history } = await withTenant(db(), tenant.id, (tx) =>
    dashboardReminders(tx, tenant.id, new Date()),
  );
  return (
    <div className="stack">
      {notice ? <div className={`notice ${sp.error ? "err" : "ok"}`}>{notice}</div> : null}
      {pending.length === 0 && history.length === 0 ? (
        <div className="card">
          <p className="sub">{T.empty}</p>
        </div>
      ) : null}
      {pending.length ? (
        <>
          <div className="day">
            <span className="label">{T.pending}</span>
          </div>
          <div className="card tight">
            {pending.map((r) => (
              <PendingRow key={r.id} r={r} />
            ))}
          </div>
        </>
      ) : null}
      {history.length ? (
        <>
          <div className="day">
            <span className="label">{T.history}</span>
          </div>
          <div className="card tight">
            {history.map((r) => (
              <HistoryRow key={r.id} r={r} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function What({ r }: { r: DashboardReminder }) {
  const amount = es.reminderAmount(r.amount, r.currency);
  return (
    <span className="what">
      <strong>{r.text}</strong>
      <span className="sub">
        <span className="sr-only">{T.when}: </span>
        {cuando(r.dueAt)}
        {amount ? (
          <>
            {" · "}
            <span className="sr-only">{T.amount}: </span>
            <span className="num">{amount}</span>
          </>
        ) : null}
      </span>
    </span>
  );
}

function PendingRow({ r }: { r: DashboardReminder }) {
  const { date, time } = localParts(r.dueAt);
  return (
    <div className="rem">
      <div className="row">
        <span className="ico lg" aria-hidden="true">
          <IconClock />
        </span>
        <What r={r} />
      </div>
      <div className="rem-actions">
        <form action={markDoneAction}>
          <input type="hidden" name="id" value={r.id} />
          <button className="btn small" type="submit">
            {T.done}
          </button>
        </form>
        <details className="rem-more">
          <summary className="linkbtn">{T.edit}</summary>
          <form action={editReminderAction} className="stack-sm rem-edit">
            <input type="hidden" name="id" value={r.id} />
            <label className="field">
              <span>{T.what}</span>
              <input
                className="input"
                name="text"
                defaultValue={r.text ?? ""}
                maxLength={80}
                required
              />
            </label>
            <div className="grid-2">
              <label className="field">
                <span>Fecha</span>
                <input className="input" type="date" name="date" defaultValue={date} required />
              </label>
              <label className="field">
                <span>Hora</span>
                <input className="input" type="time" name="time" defaultValue={time} required />
              </label>
            </div>
            <div className="grid-2">
              <label className="field">
                <span>{T.amount}</span>
                <input
                  className="input"
                  name="amount"
                  inputMode="decimal"
                  defaultValue={r.amount ? r.amount.replace(".", ",") : ""}
                  placeholder="Opcional"
                />
              </label>
              <label className="field">
                <span>Moneda</span>
                <select className="input" name="currency" defaultValue={r.currency ?? "USD"}>
                  <option value="USD">$</option>
                  <option value="VES">Bs</option>
                  <option value="EUR">€</option>
                </select>
              </label>
            </div>
            <div>
              <button className="btn small" type="submit">
                Guardar
              </button>
            </div>
          </form>
        </details>
        <details className="rem-more">
          <summary className="linkbtn danger">{T.del}</summary>
          <form action={deleteReminderAction} className="rem-confirm">
            <input type="hidden" name="id" value={r.id} />
            <p>{T.delConfirm}</p>
            <button className="btn small danger" type="submit">
              {T.del}
            </button>
            <a className="linkbtn" href="/recordatorios">
              {T.cancel}
            </a>
          </form>
        </details>
      </div>
    </div>
  );
}

function HistoryRow({ r }: { r: DashboardReminder }) {
  const via = r.deliveredVia ? es.REMINDER_VIA_LABEL[r.deliveredVia] : null;
  return (
    <div className="row">
      <span className="ico lg muted" aria-hidden="true">
        <IconClock />
      </span>
      <What r={r} />
      <span className="rem-status">
        {r.status === "expired" ? (
          <>
            <span className="badge">{T.statusExpired}</span>
            <span className="sub">{T.expiredHelp}</span>
          </>
        ) : r.linkedMovementId && r.movementType ? (
          <a className="linkbtn" href={`/movimientos/${r.linkedMovementId}`}>
            {r.movementType === "income" ? T.statusDoneIncome : T.statusDoneExpense}
          </a>
        ) : (
          <span className="badge ok">{T.statusDone}</span>
        )}
        {via && r.status === "done" ? <span className="sub">{via}</span> : null}
      </span>
    </div>
  );
}
