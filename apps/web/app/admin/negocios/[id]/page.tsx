import { es, latestRates, launchSettings, PLANS, quote, RECHARGE } from "@caja/core";
import { businessDateOf, formatShortDate } from "@caja/core/domain";
import { loadTenantDetail, requireAdmin } from "@/lib/admin";
import { db } from "@/lib/db";
import { formatE164 } from "@/lib/phone";
import {
  approvePaymentAction,
  changeTenantAction,
  eraseTenantAction,
  giftRechargeAction,
  recordPaymentAction,
  rejectPaymentAction,
  restoreTenantAction,
  saveCrmAction,
  setFounderAction,
} from "../../actions";
import { dueClass, dueText, METHOD_LABEL, planClass, STATE, usd, ves } from "../../format";

const OK: Record<string, string> = {
  pago_aprobado: "Pago aprobado. El negocio quedó activo con la nueva fecha.",
  pago_registrado: "Pago registrado. Queda por verificar.",
  pago_rechazado: "Pago rechazado.",
  guardado: "Cambio guardado.",
  papelera: "Negocio en la papelera: se borra solo en 15 días.",
  recuperado: "Negocio recuperado de la papelera.",
  recarga: `Recarga regalada: +${RECHARGE.messages} mensajes este mes.`,
};
const bucket = (id: string | undefined) =>
  id ? (es.PRICE_BUCKETS.find((b) => b.id === id)?.title ?? id) : "sin respuesta";
const ERR: Record<string, string> = {
  datos: "Revisa los datos del formulario.",
  monto: "El monto no se entiende. Escríbelo como 19,99 o 19.527,03.",
  sin_vigencia: "No queda vigencia: primero registra un pago o extiende la fecha.",
  confirmar: "Para eliminar, escribe el nombre del negocio exactamente.",
  servidor: "No se pudo guardar. Revisa los logs.",
};
const ACTION: Record<string, string> = {
  create: "Pago registrado",
  approve_payment: "Pago aprobado",
  reject: "Pago rechazado",
  change_plan: "Plan cambiado",
  extend: "Fecha extendida",
  suspend: "Suspendido a mano",
  reactivate: "Reactivado",
  trial_budget: "Tope de prueba cambiado",
  request_deletion: "Enviado a la papelera",
  restore: "Recuperado de la papelera",
  suspend_expired: "Suspendido por vencimiento",
  founder_on: "Precio fundador activado",
  founder_off: "Precio fundador quitado",
};
const PAY_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "por verificar", cls: "warn" },
  approved: { label: "aprobado", cls: "ok" },
  rejected: { label: "rechazado", cls: "" },
};

const PHONE_STATUS: Record<string, string> = {
  active: "activo",
  pending: "sin vincular",
  disabled: "desactivado",
};

const day = (d: Date) => formatShortDate(businessDateOf(d));

/** Usado de un tope, con barra (ámbar al 80 %, roja al pasarlo). */
function Meter({
  label,
  used,
  cap,
  note,
}: {
  label: string;
  used: number;
  cap: number;
  note?: string | null;
}) {
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  return (
    <div className="tile">
      <span className="label">{label}</span>
      <strong className="num tile-n">
        {used} <span className="sub">de {cap}</span>
      </strong>
      <div className="usage" aria-hidden="true">
        <span
          style={{ width: `${pct}%` }}
          className={used > cap ? "over" : pct >= 80 ? "warn" : ""}
        />
      </div>
      {note ? <span className="hint">{note}</span> : null}
    </div>
  );
}

/** Fila etiqueta / valor. */
function Line({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="line">
      <span className="sub">{label}</span>
      <strong className={`num ${cls ?? ""}`}>{value}</strong>
    </div>
  );
}

/** Ficha de un negocio: vigencia, uso del mes, números, pagos y acciones del administrador. */
export default async function AdminTenant({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  await requireAdmin();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const now = new Date();
  const [d, rates, launch] = await Promise.all([
    loadTenantDetail(id, now),
    latestRates(db()),
    launchSettings(db()),
  ]);
  const t = d.tenant;
  const extra = t.extraMonth === d.usage.month ? t.extraMessages : 0;
  const survey = (t.survey ?? {}) as Record<string, string | undefined>;
  const suggested = Object.fromEntries(
    (["pago_movil", "zelle", "binance"] as const).map((m) => [
      m,
      quote(d.plan, m, 1, rates)?.amount.toFixed(2) ?? "",
    ]),
  );

  return (
    <div className="stack">
      <a className="sub" href="/admin">
        ← Todos los negocios
      </a>
      {sp.ok && OK[sp.ok] ? <div className="notice ok">{OK[sp.ok]}</div> : null}
      {sp.error ? (
        <div className="notice err">
          {ERR[sp.error] ?? "No pudimos guardar el cambio. Inténtalo de nuevo."}
        </div>
      ) : null}

      <section className="card hero">
        <span className="label">{t.name}</span>
        <p className="admin-plan-line" style={{ margin: "var(--space-2) 0" }}>
          <span className={`plan-chip ${planClass(t.plan)}`}>{d.plan.name}</span>
          {t.deletedAt ? (
            <span className="badge late">papelera</span>
          ) : (
            <span className={`badge ${STATE[d.state.kind].cls}`}>{STATE[d.state.kind].label}</span>
          )}
        </p>
        <p className={`kpi ${dueClass(d.state)}`}>{dueText(d.state)}</p>
        <p className="sub">
          Alta: {day(t.createdAt)} ·{" "}
          {t.signupChannel === "whatsapp" ? "por WhatsApp" : "por la web"}
          {t.crmTags.length ? ` · ${t.crmTags.join(", ")}` : ""}
        </p>
        <div className="grid-2 admin-meters">
          {t.status === "trial" ? (
            <Meter
              label="Prueba gratis"
              used={d.trial.messages}
              cap={d.trial.messageCap}
              note={
                d.trial.reached ? "Llegó al tope: el bot no registra" : "mensajes desde el alta"
              }
            />
          ) : null}
          <Meter
            label="Este mes"
            used={d.usage.inbound}
            cap={d.plan.messagesPerMonth + extra}
            note={extra ? `incluye +${extra} de recarga` : "mensajes del plan"}
          />
        </div>
      </section>

      <section className="card">
        <span className="label">Uso y costos</span>
        <p className="sub admin-sub">Este mes</p>
        <Line label="Respuestas de Rocco" value={String(d.usage.outbound)} />
        <Line label={`IA (${d.usage.aiTurns} turnos)`} value={usd(d.usage.aiCostUsd)} />
        {t.status === "trial" ? (
          <>
            <p className="sub admin-sub">Prueba gratis, desde el alta</p>
            <Line
              label={`Gasto total (tope ${usd(d.trial.budgetUsd)}${t.trialBudgetUsd === null ? ", red de seguridad" : ", propio"})`}
              value={usd(d.trial.spentUsd)}
              cls={d.trial.reached ? "neg" : ""}
            />
            <Line label="IA" value={usd(d.trial.aiUsd)} />
            <Line label={`Meta (${d.trial.replies} respuestas)`} value={usd(d.trial.metaUsd)} />
            <Line label="Notas de voz" value={usd(d.trial.voiceUsd)} />
          </>
        ) : null}
      </section>

      <section className="card">
        <span className="label">CRM</span>
        <p className="sub admin-sub">Precio fundador</p>
        <Line
          label={t.founderUntil ? "40 % de descuento hasta el" : "Sin precio de fundador"}
          value={t.founderUntil ? formatShortDate(t.founderUntil as never) : "—"}
        />
        <p className="sub admin-sub">Encuesta y resumen</p>
        <Line
          label={`Encuesta de precio (día ${launch.surveyDay})`}
          value={t.surveySentAt ? `enviada ${day(t.surveySentAt)}` : "sin enviar"}
        />
        <Line label="Precio justo" value={bucket(survey.fair)} />
        <Line label="Precio caro" value={bucket(survey.expensive)} />
        <Line
          label={`Resumen (día ${launch.valueDay})`}
          value={t.valueSentAt ? `enviado ${day(t.valueSentAt)}` : "sin enviar"}
        />
        <Line
          label="¿Seguimos?"
          value={
            survey.continue === "yes"
              ? "sí"
              : survey.continue === "doubts"
                ? "tiene dudas"
                : "sin respuesta"
          }
        />
        <div className="grid-2 admin-grid admin-actions">
          <form action={setFounderAction}>
            <input type="hidden" name="tenant_id" value={t.id} />
            <input type="hidden" name="founder" value={t.founderUntil ? "off" : "on"} />
            <button className="btn small secondary block" type="submit">
              {t.founderUntil ? "Quitar fundador" : "Dar fundador (7 meses)"}
            </button>
          </form>
          <form action={giftRechargeAction}>
            <input type="hidden" name="tenant_id" value={t.id} />
            <button className="btn small secondary block" type="submit">
              Regalar +{RECHARGE.messages} mensajes
            </button>
          </form>
        </div>
        <form
          action={saveCrmAction}
          className="stack-sm admin-days"
          style={{ marginTop: "var(--space-3)" }}
        >
          <input type="hidden" name="tenant_id" value={t.id} />
          <label className="field">
            <span>Etiquetas (separadas por coma)</span>
            <input
              className="input"
              name="tags"
              defaultValue={t.crmTags.join(", ")}
              placeholder="amigo, piloto"
            />
          </label>
          <label className="field">
            <span>Notas internas</span>
            <textarea className="input" name="notes" rows={4} defaultValue={t.crmNotes ?? ""} />
          </label>
          <button className="btn small" type="submit">
            Guardar notas
          </button>
        </form>
      </section>

      <section className="card tight">
        <span className="sect">Números</span>
        {d.phones.map((p) => (
          <div className="row" key={p.id}>
            <span className="what">
              <strong>{p.displayName ?? (p.role === "owner" ? "Dueño" : "Empleado")}</strong>
              <span className="sub num">
                {formatE164(p.e164)} · {p.role === "owner" ? "dueño" : "empleado"}
              </span>
            </span>
            <span className={`badge ${p.status === "active" ? "ok" : "warn"}`}>
              {PHONE_STATUS[p.status] ?? p.status}
            </span>
          </div>
        ))}
        <p className="sub admin-pad">
          {d.phones.filter((p) => p.status === "active").length} de {d.plan.numbers} números del
          plan.
        </p>
      </section>

      <section className="card">
        <span className="label">Registrar pago</span>
        <form action={recordPaymentAction} className="stack-sm">
          <input type="hidden" name="tenant_id" value={t.id} />
          <div className="grid-3 admin-grid">
            <label className="field">
              <span>Plan</span>
              <select className="input" name="plan" defaultValue={t.plan}>
                {PLANS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {usd(p.priceUsd)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Método</span>
              <select className="input" name="method" defaultValue="pago_movil">
                <option value="pago_movil">Pago móvil (Bs)</option>
                <option value="zelle">Zelle (USD)</option>
                <option value="binance">Binance (USDT)</option>
              </select>
            </label>
            <label className="field">
              <span>Meses</span>
              <input
                className="input"
                name="months"
                type="number"
                min={1}
                max={12}
                defaultValue={1}
              />
            </label>
          </div>
          <div className="grid-2 admin-grid">
            <label className="field">
              <span>Monto recibido</span>
              <input className="input num" name="amount" inputMode="decimal" required />
            </label>
            <label className="field">
              <span>Referencia</span>
              <input className="input" name="reference" maxLength={80} />
            </label>
          </div>
          <p className="hint num">
            Para el plan {d.plan.name}, 1 mes: pago móvil {ves(suggested.pago_movil || 0)}
            {rates?.eur ? " a tasa euro" : " a tasa dólar"} · Zelle {usd(suggested.zelle || 0)} ·
            Binance {suggested.binance} USDT.
          </p>
          <label className="field">
            <span>Notas</span>
            <input className="input" name="notes" maxLength={300} />
          </label>
          <label className="admin-check">
            <input type="checkbox" name="approve" defaultChecked /> Ya lo verifiqué: aprobar y
            activar
          </label>
          <button className="btn block" type="submit">
            Guardar pago
          </button>
        </form>
      </section>

      <section className="card tight">
        <span className="sect">Pagos</span>
        {d.payments.length === 0 ? <p className="sub admin-pad">Sin pagos todavía.</p> : null}
        {d.payments.map((p) => (
          <div className="row admin-pay" key={p.id}>
            <span className="what">
              <strong className="num">
                {p.currency === "VES"
                  ? ves(p.amount)
                  : `${usd(p.amount)}${p.currency === "USDT" ? " USDT" : ""}`}
              </strong>
              <span className="sub">
                {METHOD_LABEL[p.method]} · plan {p.plan} · {p.months}{" "}
                {p.months === 1 ? "mes" : "meses"} · {day(p.createdAt)}
                {p.reference ? ` · ref ${p.reference}` : ""}
                {p.rateKind === "bcv_eur"
                  ? " · tasa euro"
                  : p.rateKind === "bcv_usd"
                    ? " · tasa dólar"
                    : ""}
                {p.notes ? ` · ${p.notes}` : ""}
              </span>
            </span>
            <span className="amts" style={{ gap: 6 }}>
              <span className={`badge ${PAY_STATUS[p.status]?.cls ?? ""}`}>
                {PAY_STATUS[p.status]?.label ?? p.status}
              </span>
              {p.status === "pending" ? (
                <>
                  <form action={approvePaymentAction}>
                    <input type="hidden" name="tenant_id" value={t.id} />
                    <input type="hidden" name="payment_id" value={p.id} />
                    <button className="btn small" type="submit">
                      Aprobar
                    </button>
                  </form>
                  <form action={rejectPaymentAction}>
                    <input type="hidden" name="tenant_id" value={t.id} />
                    <input type="hidden" name="payment_id" value={p.id} />
                    <button className="linkbtn" type="submit">
                      Rechazar
                    </button>
                  </form>
                </>
              ) : null}
            </span>
          </div>
        ))}
      </section>

      <section className="card">
        <span className="label">Acciones sin pago</span>
        <div className="stack-sm">
          <form action={changeTenantAction} className="admin-inline">
            <input type="hidden" name="tenant_id" value={t.id} />
            <input type="hidden" name="op" value="plan" />
            <select className="input" name="plan" defaultValue={t.plan} aria-label="Plan">
              {PLANS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button className="btn secondary small" type="submit">
              Cambiar plan
            </button>
          </form>
          <form action={changeTenantAction} className="admin-inline">
            <input type="hidden" name="tenant_id" value={t.id} />
            <input type="hidden" name="op" value="extend" />
            <input
              className="input"
              name="days"
              type="number"
              min={1}
              max={366}
              defaultValue={7}
              aria-label="Días a extender"
            />
            <button className="btn secondary small" type="submit">
              Extender días
            </button>
          </form>
          {t.status === "trial" ? (
            <form action={changeTenantAction} className="admin-inline">
              <input type="hidden" name="tenant_id" value={t.id} />
              <input type="hidden" name="op" value="trial_budget" />
              <input
                className="input num"
                name="budget"
                inputMode="decimal"
                defaultValue={t.trialBudgetUsd ?? ""}
                placeholder={`${d.plan.trialBudgetUsd} (plan)`}
                aria-label="Tope de gasto de la prueba en USD"
              />
              <button className="btn secondary small" type="submit">
                Tope de prueba (USD)
              </button>
            </form>
          ) : null}
          <form action={changeTenantAction}>
            <input type="hidden" name="tenant_id" value={t.id} />
            <input
              type="hidden"
              name="op"
              value={t.status === "suspended" ? "reactivate" : "suspend"}
            />
            <button
              className={`btn block ${t.status === "suspended" ? "" : "danger"}`}
              type="submit"
            >
              {t.status === "suspended" ? "Reactivar" : "Suspender ahora"}
            </button>
          </form>
        </div>
      </section>

      <section className="card stack-sm">
        <span className="label">Eliminar negocio</span>
        {t.deletedAt ? (
          <>
            <p className="sub">
              En la papelera desde {day(t.deletedAt)}
              {t.deletionReason === "unpaid"
                ? " (90 días con el plan vencido)"
                : t.deletionReason === "owner"
                  ? " (lo pidió el dueño)"
                  : ""}
              . Se borra para siempre el {t.purgeAfter ? day(t.purgeAfter) : "próximo barrido"}.
            </p>
            <form action={restoreTenantAction}>
              <input type="hidden" name="tenant_id" value={t.id} />
              <button className="btn block" type="submit">
                Recuperar
              </button>
            </form>
          </>
        ) : (
          <p className="sub">
            La papelera lo guarda 15 días (el dueño puede recuperarlo); "Borrar ya" lo elimina para
            siempre al instante: movimientos, cuentas, fotos, mensajes, números, pagos y acceso al
            panel.
          </p>
        )}
        <form action={eraseTenantAction} className="stack-sm">
          <input type="hidden" name="tenant_id" value={t.id} />
          <label className="field">
            <span>Escribe «{t.name}» para confirmar</span>
            <input className="input" name="confirm" autoComplete="off" required />
          </label>
          <div className="grid-2 admin-grid">
            {t.deletedAt ? null : (
              <button className="btn secondary danger" type="submit" name="mode" value="trash">
                A la papelera
              </button>
            )}
            <button className="btn danger" type="submit" name="mode" value="now">
              Borrar ya
            </button>
          </div>
        </form>
      </section>

      <section className="card tight">
        <span className="sect">Historial</span>
        {d.history.length === 0 ? <p className="sub admin-pad">Sin cambios todavía.</p> : null}
        {d.history.map((h) => (
          <div className="row" key={h.id}>
            <span className="what">
              <strong>{ACTION[h.action] ?? h.action}</strong>
              <span className="sub">
                {day(h.createdAt)} · {h.actorType === "system" ? "automático" : "administrador"}
              </span>
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}
