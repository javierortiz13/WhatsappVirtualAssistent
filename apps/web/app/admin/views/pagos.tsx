import type { PendingPayment } from "@/lib/admin";
import { approvePaymentAction, rejectPaymentAction } from "../actions";
import { METHOD_LABEL, usd, ves } from "../format";
import { Badge, Banner, Card, Facts, Head } from "../ui/bits";
import { ConfirmButton } from "../ui/confirm";
import { planName } from "./client-row";

export type PagosData = {
  banner: { ok: string | null; error: string | null };
  pending: PendingPayment[];
  approvedMonth: PendingPayment[];
  approvedTotalUsd: string;
  now: Date;
};

/** El monto como se pagó: «Bs 8.296,25», «$20,00», «3,20 USDT». */
export function amountOf(p: Pick<PendingPayment, "amount" | "currency">): string {
  if (p.currency === "VES") return ves(p.amount);
  return `${usd(p.amount)}${p.currency === "USDT" ? " USDT" : ""}`;
}

/** «Plan Negocio · 1 mes» o «Recarga +500 mensajes». */
export function whatFor(p: PendingPayment): string {
  if (p.kind === "recharge") return `Recarga +${p.extraMessages ?? 100} mensajes`;
  return `Plan ${planName(p.plan)}, ${p.months} ${p.months === 1 ? "mes" : "meses"}`;
}

/** «hace 3 horas», «hace 2 días». */
export function ago(at: Date, now: Date): string {
  const min = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (min < 60) return min <= 1 ? "hace un momento" : `hace ${min} minutos`;
  const h = Math.round(min / 60);
  if (h < 24) return h === 1 ? "hace 1 hora" : `hace ${h} horas`;
  const d = Math.round(h / 24);
  return d === 1 ? "hace 1 día" : `hace ${d} días`;
}

const day = (d: Date) => {
  const c = new Date(d.getTime() - 4 * 3_600_000);
  return `${String(c.getUTCDate()).padStart(2, "0")}/${String(c.getUTCMonth() + 1).padStart(2, "0")}`;
};

/** /admin/pagos: por verificar (una tarjeta cada uno, con confirmación) y los aprobados del mes. */
export function PagosView(d: PagosData) {
  return (
    <>
      <Head title="Pagos" sub="Cada aprobación o rechazo pide confirmar." />
      <Banner ok={d.banner.ok} error={d.banner.error} />
      <Card
        title="Por verificar"
        right={d.pending.length ? <Badge tone="warn">{d.pending.length}</Badge> : null}
      >
        {d.pending.length === 0 ? (
          <p className="ad-empty">No hay pagos esperando.</p>
        ) : (
          <div className="ad-items">
            {d.pending.map((p) => (
              <div className="ad-item" key={p.id}>
                <div className="ad-item-top">
                  <a className="ad-item-title" href={`/admin/negocios/${p.tenantId}?tab=pagos`}>
                    {p.tenantName}
                  </a>
                  <Badge tone="warn">por verificar</Badge>
                </div>
                <Facts
                  rows={[
                    [
                      "Monto",
                      <b key="v" className="num">
                        {amountOf(p)}
                      </b>,
                    ],
                    ["Método", METHOD_LABEL[p.method] ?? p.method],
                    ["Referencia", p.reference ?? "—"],
                    ["Para", whatFor(p)],
                    ["Llegó", ago(p.createdAt, d.now)],
                    ...(p.notes?.includes("por WhatsApp")
                      ? ([["Reportado", "por WhatsApp"]] as [string, string][])
                      : []),
                  ]}
                />
                <div className="ad-btns">
                  <form action={rejectPaymentAction}>
                    <input type="hidden" name="tenant_id" value={p.tenantId} />
                    <input type="hidden" name="payment_id" value={p.id} />
                    <input type="hidden" name="from" value="panel" />
                    <ConfirmButton
                      label="Rechazar"
                      title={`¿Rechazar el pago de ${p.tenantName}?`}
                      body={
                        <p className="ad-note">
                          {amountOf(p)} por {METHOD_LABEL[p.method] ?? p.method}. El negocio no
                          cambia de plan ni de fecha.
                        </p>
                      }
                      ok="Sí, rechazar"
                      danger
                    />
                  </form>
                  <form action={approvePaymentAction}>
                    <input type="hidden" name="tenant_id" value={p.tenantId} />
                    <input type="hidden" name="payment_id" value={p.id} />
                    <input type="hidden" name="from" value="panel" />
                    <ConfirmButton
                      label="Aprobar"
                      className="ad-btn pri"
                      title={`¿Aprobar el pago de ${p.tenantName}?`}
                      body={
                        <p className="ad-note">
                          {amountOf(p)} por {METHOD_LABEL[p.method] ?? p.method}
                          {p.reference ? `, referencia ${p.reference}` : ""}. Verifícalo en tu banco
                          o billetera: al aprobar, {whatFor(p).toLowerCase()} queda activo.
                        </p>
                      }
                      ok="Aprobar"
                    />
                  </form>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card
        title="Aprobados este mes"
        right={
          <Badge tone="ok">
            {d.approvedMonth.filter((p) => p.status === "approved").length} · {d.approvedTotalUsd}
          </Badge>
        }
      >
        {d.approvedMonth.length === 0 ? (
          <p className="ad-empty">Ninguno todavía este mes.</p>
        ) : (
          <div className="ad-items">
            {d.approvedMonth.map((p) => (
              <div className="ad-item" key={p.id}>
                <div className="ad-item-top">
                  <a className="ad-item-title" href={`/admin/negocios/${p.tenantId}?tab=pagos`}>
                    {p.tenantName}
                  </a>
                  <Badge tone={p.status === "approved" ? "ok" : "late"}>
                    {p.status === "approved" ? "aprobado" : "devuelto"}
                  </Badge>
                </div>
                <Facts
                  rows={[
                    [
                      "Monto",
                      <b key="v" className="num">
                        {amountOf(p)}
                      </b>,
                    ],
                    ["Método", METHOD_LABEL[p.method] ?? p.method],
                    ["Para", whatFor(p)],
                    ["Aprobado el", day(p.reviewedAt ?? p.createdAt)],
                  ]}
                />
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
