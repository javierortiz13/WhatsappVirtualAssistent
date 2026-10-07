import { Decimal, es, PLANS, premiumOverUsd, quote } from "@caja/core";
import { businessDateOf, formatShortDate } from "@caja/core/domain";
import {
  type Health,
  loadFunnel,
  loadPendingPayments,
  loadRates,
  loadTenants,
  requireAdmin,
  surveyTally,
} from "@/lib/admin";
import { formatE164 } from "@/lib/phone";
import { approvePaymentAction, rejectPaymentAction } from "./actions";
import { dueClass, dueText, METHOD_LABEL, planClass, STATE, usd, ves } from "./format";

/** Semáforo del CRM: cuándo escribió por última vez. */
const HEALTH: Record<Health, { label: string; cls: string }> = {
  green: { label: "al día", cls: "ok" },
  amber: { label: "3+ días sin escribir", cls: "warn" },
  red: { label: "7+ días sin escribir", cls: "late" },
};

const STEP_LABEL: Record<string, string> = {
  name: "nombre",
  kind: "para mí o negocio",
  biz_name: "nombre del negocio",
  biz_type: "tipo de negocio",
  currency: "moneda",
  categories: "categorías",
  accounts: "cuentas",
  accounts_confirm: "confirmar cuentas",
  budget: "presupuesto",
};

const OK: Record<string, string> = {
  pago_aprobado: "Pago aprobado. El negocio quedó activo.",
  pago_rechazado: "Pago rechazado.",
  eliminado: "Negocio borrado para siempre con todos sus datos.",
  papelera: "Negocio en la papelera: se borra solo en 15 días.",
};

/** Resumen de la plataforma: ingresos, costos del mes, pagos por verificar y negocios. */
export default async function AdminHome({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const now = new Date();
  const [tenants, pending, rates] = await Promise.all([
    loadTenants(now),
    loadPendingPayments(),
    loadRates(),
  ]);
  const sum = (f: (t: (typeof tenants)[number]) => Decimal) =>
    tenants.reduce((acc, t) => acc.plus(f(t)), new Decimal(0));
  const revenue = sum((t) => t.revenueUsd);
  const ai = sum((t) => t.usage.aiCostUsd);
  const meta = sum((t) => t.metaCostUsd);
  const count = (k: string) => tenants.filter((t) => t.state.kind === k).length;
  const overCap = tenants.filter((t) => t.usage.inbound > t.cap);
  const premium = rates ? premiumOverUsd(rates) : null;
  const funnel = await loadFunnel(tenants, now);
  const survey = surveyTally(tenants);
  const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)} %` : "—");
  const steps: [string, number, string][] = [
    ["Registros por WhatsApp", funnel.chatStarted, ""],
    ["Terminaron el registro", funnel.chatCompleted, pct(funnel.chatCompleted, funnel.chatStarted)],
    ["Negocios (chat + web)", funnel.tenants, `${funnel.webSignups} por la web`],
    ["Activados (3+ el 1er día)", funnel.activated, pct(funnel.activated, funnel.tenants)],
    ["Activos últimos 7 días", funnel.active7, pct(funnel.active7, funnel.tenants)],
    ["Pagando", funnel.paying, pct(funnel.paying, funnel.tenants)],
  ];

  return (
    <div className="stack">
      {sp.ok && OK[sp.ok] ? <div className="notice ok">{OK[sp.ok]}</div> : null}
      {sp.error ? <div className="notice err">No se pudo guardar el cambio.</div> : null}

      <section className="card hero">
        <span className="label">Ingreso mensual recurrente</span>
        <p className="big num mint">{usd(revenue)}</p>
        <p className="sub num">
          Costos del mes: IA {usd(ai)} · Meta {usd(meta)} · margen{" "}
          <span className={revenue.minus(ai).minus(meta).isNegative() ? "amber" : "mint"}>
            {usd(revenue.minus(ai).minus(meta))}
          </span>
        </p>
        <div className="grid-3 admin-tiles">
          <div className="tile">
            <span className="label">Activos</span>
            <strong className="num tile-n">{count("active")}</strong>
          </div>
          <div className="tile">
            <span className="label">En prueba</span>
            <strong className="num tile-n">{count("trial")}</strong>
          </div>
          <div className="tile">
            <span className="label">Vencidos o suspendidos</span>
            <strong className="num tile-n amber">
              {count("grace") + count("expired") + count("suspended")}
            </strong>
          </div>
        </div>
      </section>

      <section className="card tight">
        <span className="sect">Embudo</span>
        {steps.map(([label, n, note]) => (
          <div className="row" key={label}>
            <span className="what">
              <strong>{label}</strong>
              {note ? <span className="sub">{note}</span> : null}
            </span>
            <strong className="num">{n}</strong>
          </div>
        ))}
      </section>

      {funnel.abandoned.length ? (
        <section className="card tight">
          <span className="sect">Registros sin terminar ({funnel.abandoned.length})</span>
          {funnel.abandoned.map((a) => (
            <div className="row" key={a.e164}>
              <span className="what">
                <strong>{a.name ?? "Sin nombre"}</strong>
                <span className="sub num">
                  {formatE164(a.e164)} · se quedó en «{STEP_LABEL[a.step] ?? a.step}» ·{" "}
                  {formatShortDate(businessDateOf(a.updatedAt))}
                </span>
              </span>
              <a
                className="btn small secondary"
                href={`https://wa.me/${a.e164}`}
                target="_blank"
                rel="noreferrer"
              >
                Escribirle
              </a>
            </div>
          ))}
        </section>
      ) : null}

      {Object.keys(survey.fair).length || Object.keys(survey.continue).length ? (
        <section className="card tight">
          <span className="sect">Encuesta de precio (al mes)</span>
          {es.PRICE_BUCKETS.map((b) => (
            <div className="row" key={b.id}>
              <span className="what">{b.title}</span>
              <span className="sub num">
                justo {survey.fair[b.id] ?? 0} · caro {survey.expensive[b.id] ?? 0}
              </span>
            </div>
          ))}
          <p className="sub admin-pad">
            ¿Seguimos?: sí {survey.continue.yes ?? 0} · tengo dudas {survey.continue.doubts ?? 0}
          </p>
        </section>
      ) : null}

      <section className="card">
        <span className="label">Cobro por pago móvil</span>
        {rates ? (
          <>
            <p className="kpi-sub num">
              Dólar BCV {ves(rates.usd)}
              {rates.eur ? ` · Euro BCV ${ves(rates.eur)}` : " · euro todavía sin publicar"}
              {premium ? ` · el euro está ${premium.toString().replace(".", ",")} % arriba` : ""}
              {` · ${formatShortDate(rates.effectiveDate as never)}`}
            </p>
            <div className="list admin-list">
              {PLANS.map((p) => {
                const q = quote(p, "pago_movil", 1, rates);
                return (
                  <div className={`row ${planClass(p.id)}`} key={p.id}>
                    <span className="what">
                      <strong className="plan-name">{p.name}</strong>
                      <span className="sub">{usd(p.priceUsd)} por Zelle o Binance</span>
                    </span>
                    <span className="amts num">
                      <strong>{q ? ves(q.amount) : "sin tasa"}</strong>
                      <span className="sub">
                        {q?.rateKind === "bcv_eur" ? "a tasa euro" : "a tasa dólar"}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <p className="kpi-sub">Todavía no hay tasas BCV guardadas.</p>
        )}
      </section>

      <section className="card tight">
        <span className="sect">Pagos por verificar ({pending.length})</span>
        {pending.length === 0 ? (
          <p className="sub admin-pad">No hay pagos esperando.</p>
        ) : (
          pending.map((p) => (
            <div className="row admin-pay" key={p.id}>
              <span className="what">
                <strong>
                  <a href={`/admin/negocios/${p.tenantId}`}>{p.tenantName}</a>
                </strong>
                <span className="sub num">
                  {METHOD_LABEL[p.method]} · {p.currency === "VES" ? ves(p.amount) : usd(p.amount)}
                  {p.reference ? ` · ref ${p.reference}` : ""} · plan {p.plan}
                  {p.months > 1 ? ` × ${p.months} meses` : ""}
                  {p.kind === "recharge" ? " · recarga +100 mensajes" : ""}
                  {p.notes?.includes("por WhatsApp") ? " · por WhatsApp" : ""}
                </span>
              </span>
              <span className="amts">
                <form action={approvePaymentAction}>
                  <input type="hidden" name="tenant_id" value={p.tenantId} />
                  <input type="hidden" name="payment_id" value={p.id} />
                  <input type="hidden" name="from" value="panel" />
                  <button className="btn small" type="submit">
                    Aprobar
                  </button>
                </form>
                <form action={rejectPaymentAction}>
                  <input type="hidden" name="tenant_id" value={p.tenantId} />
                  <input type="hidden" name="payment_id" value={p.id} />
                  <input type="hidden" name="from" value="panel" />
                  <button className="linkbtn" type="submit">
                    Rechazar
                  </button>
                </form>
              </span>
            </div>
          ))
        )}
      </section>

      {overCap.length ? (
        <div className="notice err">
          Sobre el límite del plan este mes:{" "}
          {overCap.map((t) => `${t.name} (${t.usage.inbound}/${t.cap})`).join(", ")}. Rocco dejó de
          registrar: ofréceles la recarga o el plan superior.
        </div>
      ) : null}

      <section className="card tight">
        <span className="sect">Negocios ({tenants.length})</span>
        {tenants.map((t) => (
          <a className="row admin-tenant" key={t.id} href={`/admin/negocios/${t.id}`}>
            <span className="what">
              <strong>{t.name}</strong>
              <span className="sub admin-plan-line">
                <span className={`plan-chip ${planClass(t.plan)}`}>
                  {PLANS.find((p) => p.id === t.plan)?.name ?? t.plan}
                </span>
                <span className={dueClass(t.state)}>{dueText(t.state)}</span>
                {t.founderUntil ? <span className="badge ok">fundador</span> : null}
                <span className="sub">{t.signupChannel === "whatsapp" ? "WhatsApp" : "web"}</span>
                {t.crmTags.map((tag) => (
                  <span className="badge" key={tag}>
                    {tag}
                  </span>
                ))}
              </span>
              <span className="sub num">
                {t.usage.inbound}/{t.cap} registros · IA {usd(t.usage.aiCostUsd)} · Meta{" "}
                {usd(t.metaCostUsd)}
                {t.pendingPayments ? ` · ${t.pendingPayments} pago por verificar` : ""}
              </span>
            </span>
            <span className="amts" style={{ gap: 6 }}>
              <span className={`badge ${HEALTH[t.health].cls}`} title="Último mensaje">
                {HEALTH[t.health].label}
              </span>
              {t.purgeAfter ? (
                <span className="badge late">papelera</span>
              ) : (
                <span className={`badge ${STATE[t.state.kind].cls}`}>
                  {STATE[t.state.kind].label}
                </span>
              )}
              <span
                className={`num sub ${t.marginUsd.isNegative() ? "due late" : ""}`}
                title="Margen del mes"
              >
                {usd(t.marginUsd)}
              </span>
            </span>
          </a>
        ))}
      </section>
    </div>
  );
}
