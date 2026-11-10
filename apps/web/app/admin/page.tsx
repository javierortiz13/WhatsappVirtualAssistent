import { Decimal } from "@caja/core";
import { loadMonthOutbound, loadReferrals } from "@/lib/admin";
import { getAdmin, getFunnel, getNow, getPayments, getTenants } from "./data";
import { needsAttention, toContact } from "./derive";
import { usd } from "./format";
import { errorText, OK, type SectionParams } from "./messages";
import { ago } from "./views/pagos";
import { ResumenView } from "./views/resumen";

/** /admin → Resumen (rediseño 08/11). */
export default async function AdminResumen({
  searchParams,
}: {
  searchParams: Promise<SectionParams>;
}) {
  await getAdmin();
  const sp = await searchParams;
  const now = getNow();
  const [tenants, payments, funnel] = await Promise.all([getTenants(), getPayments(), getFunnel()]);
  // Ingresos y conteos son de clientes; los costos de IA y Meta, de todo (las internas también gastan).
  const clients = tenants.filter((t) => !t.internal);
  const sum = (list: typeof tenants, f: (t: (typeof tenants)[number]) => Decimal) =>
    list.reduce((acc, t) => acc.plus(f(t)), new Decimal(0));
  const revenue = sum(clients, (t) => t.revenueUsd);
  const ai = sum(tenants, (t) => t.usage.aiCostUsd);
  const meta = sum(tenants, (t) => t.metaCostUsd);
  const margin = revenue.minus(ai).minus(meta);
  const count = (k: string) => clients.filter((t) => t.state.kind === k).length;
  const [monthOut, refs] = await Promise.all([
    loadMonthOutbound(tenants, now),
    loadReferrals(tenants, now),
  ]);
  const contact = toContact(funnel.abandoned);
  const oldestPay = payments.pending[0];
  const oldestSignup = contact.at(-1);
  return (
    <ResumenView
      banner={{ ok: sp.ok ? (OK[sp.ok] ?? null) : null, error: errorText(sp.error, sp.motivo) }}
      revenue={usd(revenue)}
      ai={usd(ai)}
      meta={usd(meta)}
      margin={usd(margin)}
      marginNegative={margin.isNegative()}
      active={count("active")}
      trial={count("trial")}
      grace={count("grace")}
      expired={count("expired")}
      suspended={count("suspended")}
      monthOut={monthOut}
      todo={{
        payments: payments.pending.length,
        paymentsNote: oldestPay
          ? `El más viejo, de ${oldestPay.tenantName}, llegó ${ago(oldestPay.createdAt, now)}.`
          : "Nada esperando.",
        signups: contact.length,
        signupsNote: oldestSignup
          ? `El más viejo se quedó ${ago(oldestSignup.updatedAt, now)}.`
          : "Nadie por contactar.",
        overCap: tenants
          .filter((t) => t.usage.inbound > t.cap)
          .map((t) => ({ name: t.name, inbound: t.usage.inbound, cap: t.cap })),
        refMonths: refs.review.length,
      }}
      internal={tenants.length - clients.length}
      funnel={[
        { label: "Registros por WhatsApp", value: funnel.chatStarted },
        { label: "Terminaron el registro", value: funnel.chatCompleted },
        {
          label: "Negocios (chat + web)",
          value: funnel.tenants,
          note: `${funnel.webSignups} por la web`,
        },
        { label: "Activados (3+ el 1er día)", value: funnel.activated },
        { label: "Activos últimos 7 días", value: funnel.active7 },
        { label: "Pagando", value: funnel.paying },
      ]}
      attention={needsAttention(tenants)}
    />
  );
}
