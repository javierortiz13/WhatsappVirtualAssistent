import {
  BETA,
  founderDiscount,
  latestRates,
  monthUsage,
  PLANS,
  planById,
  quote,
  subscriptionState,
  trialSpend,
  unpaidTrashDate,
} from "@caja/core";
import { businessDateOf, formatShortDate } from "@caja/core/domain";
import { desc, eq, schema, withTenant } from "@caja/db";
import type { Metadata } from "next";
import { dueClass, dueText, METHOD_LABEL, planClass, STATE, usd, ves } from "@/app/admin/format";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { requireTenant } from "@/lib/session";
import { IconChevronLeft } from "../../icons";
import { reportPaymentAction } from "../cuenta-actions";

export const metadata: Metadata = { title: "Mi plan" };
export const dynamic = "force-dynamic";

const OK: Record<string, string> = {
  reportado:
    "Recibimos tu reporte. Lo verificamos y, al aprobarlo, tu plan se extiende 30 días por mes pagado.",
};
const ERRORS: Record<string, string> = {
  datos: "Revisa los datos: plan, método, meses y una referencia de al menos 3 caracteres.",
  monto: "El monto no se entiende. Escríbelo como 19,99 o 19.527,03.",
  pendientes: "Ya tienes 3 pagos por verificar. Espera a que los revisemos.",
  permiso: "Solo el dueño puede reportar pagos.",
  servidor: "No pudimos guardar el reporte. Inténtalo en unos minutos.",
};
const PAY_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "por verificar", cls: "warn" },
  approved: { label: "aprobado", cls: "ok" },
  rejected: { label: "rechazado", cls: "" },
};

/** Mi plan: vigencia, uso del mes, planes, cómo pagar y reportar el pago (ADR-015). */
export default async function MiPlan({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { tenant } = await requireTenant();
  const sp = await searchParams;
  const now = new Date();
  const [{ t, usage, trial, payments }, rates] = await Promise.all([
    withTenant(db(), tenant.id, async (tx) => {
      const [t] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenant.id));
      return {
        t,
        usage: await monthUsage(tx, tenant.id, now),
        trial: t?.status === "trial" ? await trialSpend(tx, t) : null,
        payments: await tx
          .select()
          .from(schema.payment)
          .where(eq(schema.payment.tenantId, tenant.id))
          .orderBy(desc(schema.payment.createdAt))
          .limit(10),
      };
    }),
    latestRates(db()),
  ]);
  if (!t) return null;
  const plan = planById(t.plan);
  const state = subscriptionState(t, now);
  // En la prueba la barra es el tope de gasto (0016): al 100 % el asistente deja de registrar.
  const pct = trial
    ? trial.budgetUsd.isZero()
      ? 100
      : Math.min(100, Math.round(trial.spentUsd.div(trial.budgetUsd).toNumber() * 100))
    : Math.min(100, Math.round((usage.inbound / plan.messagesPerMonth) * 100));
  const e = env();
  const dest = {
    pago_movil: e.PAYMENT_PAGO_MOVIL,
    zelle: e.PAYMENT_ZELLE,
    binance: e.PAYMENT_BINANCE,
  } as const;
  const support = e.SUPPORT_HINT;
  // Precio fundador (0019): los montos ya van con el descuento, igual que en el chat.
  const founderPct = founderDiscount(t, now);
  const q = (m: "pago_movil" | "zelle" | "binance") =>
    quote(plan, m, 1, rates, "bcv_eur", founderPct);

  return (
    <div className="stack">
      <div className="rate">
        <a className="iconbtn" href="/ajustes" aria-label="Volver a ajustes">
          <IconChevronLeft />
        </a>
        <span className="sub">Ajustes</span>
      </div>
      {sp.ok && OK[sp.ok] ? <div className="notice ok">{OK[sp.ok]}</div> : null}
      {sp.error ? (
        <div className="notice err">
          {ERRORS[sp.error] ?? "No pudimos guardar el cambio. Inténtalo de nuevo."}
        </div>
      ) : null}

      <section className={`card hero plan-card ${planClass(plan.id)}`}>
        <span className="label">Tu plan</span>
        <p className="admin-plan-line" style={{ margin: "var(--space-2) 0" }}>
          <span className={`plan-chip ${planClass(plan.id)}`}>{plan.name}</span>
          <span className={`badge ${STATE[state.kind].cls}`}>{STATE[state.kind].label}</span>
        </p>
        <p className={`kpi ${dueClass(state)}`}>{dueText(state)}</p>
        <div className="usage" aria-hidden="true">
          <span style={{ width: `${pct}%` }} className={pct >= 90 ? "warn" : ""} />
        </div>
        {trial ? (
          <p className="sub">
            {trial.reached
              ? "Usaste todo lo incluido en la prueba gratis y Rocco dejó de registrar. Tus datos siguen guardados: paga y repórtalo aquí abajo para seguir."
              : `Prueba gratis: llevas el ${pct} % del uso incluido. Al llegar al 100 % o a la fecha, Rocco deja de registrar hasta que actives el plan.`}
          </p>
        ) : null}
        {t.status === "suspended" && t.suspendedAt ? (
          <p className="sub">
            Tu plan está suspendido. Guardamos tus datos hasta el{" "}
            <strong>{formatShortDate(businessDateOf(unpaidTrashDate(t.suspendedAt)))}</strong>.
            Después pasan a la papelera y a los 15 días se borran. Renueva abajo o descarga tu Excel
            en Ajustes → Exportar.
          </p>
        ) : null}
        <p className="sub num">
          Este mes: {usage.inbound} de{" "}
          {plan.messagesPerMonth + (t.extraMonth === usage.month ? t.extraMessages : 0)} mensajes ·{" "}
          {usage.phones} de {plan.numbers} números
        </p>
        {founderPct && t.founderUntil ? (
          <p className="sub">
            🎁 Precio de fundador: {founderPct} % menos hasta el{" "}
            {formatShortDate(t.founderUntil as never)}. Los montos ya van descontados.
          </p>
        ) : null}
      </section>

      <span className="sect">Planes</span>
      {PLANS.map((p) => {
        const pm = quote(p, "pago_movil", 1, rates, "bcv_eur", founderPct);
        const current = p.id === plan.id;
        return (
          <section
            key={p.id}
            className={`card plan-card ${planClass(p.id)}${current ? " current" : ""}`}
          >
            <div className="admin-plan-line">
              <span className={`plan-chip ${planClass(p.id)}`}>{p.name}</span>
              {current ? <span className="badge ok">tu plan</span> : null}
            </div>
            {BETA && t.status === "trial" ? (
              <p className="plan-price">
                Gratis <span className="sub">durante la beta</span>
              </p>
            ) : (
              <>
                <p className="plan-price">
                  {usd(p.priceUsd)} <span className="sub">al mes</span>
                </p>
                <p className="sub num">
                  {pm ? `${ves(pm.amount)} por pago móvil` : ""}
                  {pm?.rateKind === "bcv_eur" ? " (tasa euro BCV del día)" : ""}
                </p>
              </>
            )}
            <p className="sub">{p.tagline}</p>
            <ul>
              {p.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </section>
        );
      })}

      <span className="sect">Cómo pagar el plan {plan.name}</span>
      <section className="card stack-sm">
        {(["pago_movil", "zelle", "binance"] as const).map((m) => {
          const qm = q(m);
          return (
            <div className="pay-method" key={m}>
              <span className="label">{METHOD_LABEL[m]}</span>
              <strong>
                {qm
                  ? m === "pago_movil"
                    ? ves(qm.amount)
                    : m === "zelle"
                      ? usd(qm.amount)
                      : `${qm.amount.toFixed(2)} USDT`
                  : "sin tasa del día"}
              </strong>
              <span className="sub">
                {dest[m] ??
                  (support
                    ? `Pídenos los datos: ${support}`
                    : "Pídele los datos a Rocco por WhatsApp.")}
              </span>
            </div>
          );
        })}
        <p className="hint">
          El pago móvil se calcula con la tasa euro del BCV de hoy, porque nuestros servicios se
          pagan en dólares. Si pagas varios meses, multiplica el monto.
        </p>
      </section>

      <section className="card" id="reportar">
        <span className="label">Ya pagué</span>
        <form
          action={reportPaymentAction}
          className="stack-sm"
          style={{ marginTop: "var(--space-2)" }}
        >
          <div className="grid-2 admin-grid">
            <label className="field">
              <span>Plan</span>
              <select className="input" name="plan" defaultValue={plan.id}>
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
          </div>
          <div className="grid-3 admin-grid">
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
            <label className="field">
              <span>Monto pagado</span>
              <input className="input num" name="amount" inputMode="decimal" required />
            </label>
            <label className="field">
              <span>Referencia</span>
              <input className="input" name="reference" minLength={3} maxLength={80} required />
            </label>
          </div>
          <button className="btn block" type="submit">
            Reportar pago
          </button>
          <p className="hint">
            Lo verificamos a mano, normalmente el mismo día. Tu plan se activa al aprobarlo.
          </p>
        </form>
      </section>

      <section className="card tight" id="pagos">
        <span className="sect">Tus pagos</span>
        {payments.length === 0 ? <p className="sub admin-pad">Todavía no hay pagos.</p> : null}
        {payments.map((p) => (
          <div className="row" key={p.id}>
            <span className="what">
              <strong className="num">
                {p.currency === "VES"
                  ? ves(p.amount)
                  : `${usd(p.amount)}${p.currency === "USDT" ? " USDT" : ""}`}
              </strong>
              <span className="sub">
                {METHOD_LABEL[p.method]} · plan {planById(p.plan).name} · {p.months}{" "}
                {p.months === 1 ? "mes" : "meses"} · {formatShortDate(businessDateOf(p.createdAt))}
              </span>
            </span>
            <span className={`badge ${PAY_STATUS[p.status]?.cls ?? ""}`}>
              {PAY_STATUS[p.status]?.label ?? p.status}
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}
