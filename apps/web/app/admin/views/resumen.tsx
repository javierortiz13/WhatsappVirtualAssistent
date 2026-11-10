import type { TenantRow } from "@/lib/admin";
import { Badge, Banner, Bars, Card, Head, Kpi } from "../ui/bits";
import { ClientRow } from "./client-row";

export type ResumenData = {
  banner: { ok: string | null; error: string | null };
  /** Ingreso mensual recurrente (lo que pagan, con el descuento de fundador). */
  revenue: string;
  ai: string;
  meta: string;
  margin: string;
  marginNegative: boolean;
  active: number;
  trial: number;
  grace: number;
  expired: number;
  suspended: number;
  monthOut: number | null;
  todo: {
    payments: number;
    paymentsNote: string;
    signups: number;
    signupsNote: string;
    overCap: { name: string; inbound: number; cap: number }[];
    refMonths: number;
  };
  internal: number;
  funnel: { label: string; value: number; note?: string }[];
  attention: TenantRow[];
};

/** /admin: lo del mes en grande, lo pendiente, el embudo y los clientes que necesitan atención. */
export function ResumenView(d: ResumenData) {
  const pending = d.todo.payments + d.todo.signups + d.todo.overCap.length + d.todo.refMonths;
  const max = d.funnel[0]?.value || 1;
  return (
    <>
      <Head title="Resumen" sub="Lo que pasa este mes, sin las cuentas internas." />
      <Banner ok={d.banner.ok} error={d.banner.error} />
      <div className="ad-grid ad-g4">
        <Kpi
          hero
          label="Ingreso mensual recurrente"
          value={d.revenue}
          sub={
            <>
              Quedan <b className={d.marginNegative ? "ad-down" : "ad-up"}>{d.margin}</b> después de
              IA y Meta
              <br />
              IA {d.ai} y Meta {d.meta} este mes
            </>
          }
        />
        <Kpi label="Activos" value={d.active} />
        <Kpi label="En prueba" value={d.trial} />
        <Kpi
          label="Vencidos o en gracia"
          value={d.grace + d.expired + d.suspended}
          tone={d.grace + d.expired + d.suspended ? "warn" : undefined}
          sub={d.suspended ? `incluye ${d.suspended} suspendidos` : undefined}
        />
        <Kpi
          label="Mensajes del mes"
          value={d.monthOut ?? "—"}
          sub="Todos los del número, con el registro. Meta regala 1.000 de servicio al mes; después cobra cada uno."
        />
      </div>
      <div className="ad-grid ad-g2">
        <Card title="Para hacer hoy" right={pending ? <Badge tone="warn">{pending}</Badge> : null}>
          <div className="ad-inbox">
            <Task
              href="/admin/pagos"
              icon="$"
              bg="var(--amber-soft)"
              title={`${d.todo.payments} ${d.todo.payments === 1 ? "pago" : "pagos"} por verificar`}
              sub={d.todo.paymentsNote}
            />
            <Task
              href="/admin/registro"
              icon="✎"
              bg="var(--plan-personal-soft)"
              title={`${d.todo.signups} ${d.todo.signups === 1 ? "registro" : "registros"} sin terminar por contactar`}
              sub={d.todo.signupsNote}
            />
            <Task
              href="/admin/clientes?orden=tope"
              icon="!"
              bg="rgba(245,107,107,.14)"
              title={`${d.todo.overCap.length} ${d.todo.overCap.length === 1 ? "cliente" : "clientes"} sobre el límite`}
              sub={
                d.todo.overCap.length
                  ? `${d.todo.overCap.map((t) => `${t.name} (${t.inbound} de ${t.cap})`).join(", ")}. Rocco dejó de registrar: ofréceles la recarga o el plan superior.`
                  : "Nadie pasó el límite de su plan este mes."
              }
            />
            <Task
              href="/admin/puntos#invitaciones"
              icon="★"
              bg="var(--mint-soft)"
              title={`${d.todo.refMonths} ${d.todo.refMonths === 1 ? "mes" : "meses"} de regalo por revisar`}
              sub={d.todo.refMonths ? "Aprobar o rechazar en Puntos." : "Nada pendiente."}
            />
          </div>
        </Card>
        <Card
          title="Embudo"
          right={
            d.internal ? (
              <span className="ad-note">
                sin {d.internal} cuenta{d.internal === 1 ? "" : "s"} interna
                {d.internal === 1 ? "" : "s"}
              </span>
            ) : null
          }
        >
          <Bars
            rows={d.funnel.map((s, i) => {
              const prev = i ? d.funnel[i - 1]?.value : null;
              const pct = prev ? `${Math.round((100 * s.value) / prev)} % del paso anterior` : null;
              return {
                label: s.label,
                value: s.value,
                max,
                note: [pct, s.note].filter(Boolean).join(". ") || undefined,
              };
            })}
          />
        </Card>
      </div>
      <Card
        title="Clientes que necesitan atención"
        right={
          <a className="ad-note" href="/admin/clientes">
            Ver todos →
          </a>
        }
      >
        {d.attention.length ? (
          <div className="ad-list flat">
            {d.attention.map((t) => (
              <ClientRow key={t.id} t={t} />
            ))}
          </div>
        ) : (
          <p className="ad-empty">Todos al día.</p>
        )}
      </Card>
    </>
  );
}

function Task({
  href,
  icon,
  bg,
  title,
  sub,
}: {
  href: string;
  icon: string;
  bg: string;
  title: string;
  sub: string;
}) {
  return (
    <a className="ad-task" href={href}>
      <span className="ad-task-ic" style={{ background: bg }} aria-hidden="true">
        {icon}
      </span>
      <span className="ad-task-tx">
        <span className="ad-task-t">{title}</span>
        <span className="ad-task-s">{sub}</span>
      </span>
      <span className="ad-task-go" aria-hidden="true">
        ›
      </span>
    </a>
  );
}
