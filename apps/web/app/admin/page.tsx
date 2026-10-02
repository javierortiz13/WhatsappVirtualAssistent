import { Decimal, PLANS, premiumOverUsd, quote } from "@caja/core";
import { formatShortDate } from "@caja/core/domain";
import { loadPendingPayments, loadRates, loadTenants } from "@/lib/admin";
import { approvePaymentAction, rejectPaymentAction } from "./actions";
import { dueText, METHOD_LABEL, STATE, usd, ves } from "./format";

const OK: Record<string, string> = {
  pago_aprobado: "Pago aprobado. El negocio quedó activo.",
  pago_rechazado: "Pago rechazado.",
};

/** Resumen de la plataforma: ingresos, costos del mes, pagos por verificar y negocios. */
export default async function AdminHome({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
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

  return (
    <div className="stack">
      {sp.ok && OK[sp.ok] ? <div className="notice ok">{OK[sp.ok]}</div> : null}
      {sp.error ? <div className="notice err">No se pudo guardar ({sp.error}).</div> : null}

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
                  <div className="row" key={p.id}>
                    <span className="what">
                      <strong>{p.name}</strong>
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
          {overCap.map((t) => `${t.name} (${t.usage.inbound}/${t.cap})`).join(", ")}. El bot sigue
          funcionando; ofréceles el plan superior.
        </div>
      ) : null}

      <section className="card tight">
        <span className="sect">Negocios ({tenants.length})</span>
        {tenants.map((t) => (
          <a className="row admin-tenant" key={t.id} href={`/admin/negocios/${t.id}`}>
            <span className="what">
              <strong>{t.name}</strong>
              <span className="sub">
                {PLANS.find((p) => p.id === t.plan)?.name ?? t.plan} · {dueText(t.state)}
              </span>
              <span className="sub num">
                {t.usage.inbound}/{t.cap} registros · IA {usd(t.usage.aiCostUsd)} · Meta{" "}
                {usd(t.metaCostUsd)}
                {t.pendingPayments ? ` · ${t.pendingPayments} pago por verificar` : ""}
              </span>
            </span>
            <span className="amts" style={{ gap: 6 }}>
              <span className={`badge ${STATE[t.state.kind].cls}`}>
                {STATE[t.state.kind].label}
              </span>
              <span
                className={`num sub ${t.marginUsd.isNegative() ? "amber" : ""}`}
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
