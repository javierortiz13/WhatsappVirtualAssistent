import {
  accountBalances,
  BUSINESS_TYPE_LABELS,
  Decimal,
  exchangeLots,
  formatMoney,
  getTenantSettings,
  planById,
  subscriptionState,
  tenantPhones,
} from "@caja/core";
import { eq, schema, withTenant } from "@caja/db";
import type { Metadata } from "next";
import { dueClass, dueText, planClass } from "@/app/admin/format";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";
import {
  IconCard,
  IconChevronRight,
  IconDownload,
  IconLogout,
  IconPhone,
  IconStore,
  IconSwap,
  IconTags,
  IconUser,
  IconWallet,
} from "../icons";

export const metadata: Metadata = { title: "Ajustes" };
export const dynamic = "force-dynamic";

/** Portada de ajustes: una tarjeta por sección. Cada una vive en su propia página. */
export default async function Ajustes() {
  const { user, tenant } = await requireTenant();
  const { phones, settings, billing, lots, accounts } = await withTenant(
    db(),
    tenant.id,
    async (tx) => ({
      phones: await tenantPhones(tx, tenant.id),
      settings: await getTenantSettings(tx, tenant.id),
      billing: (await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenant.id)))[0],
      lots: await exchangeLots(tx, tenant.id, { source: "exchange" }),
      accounts: await accountBalances(tx, tenant.id),
    }),
  );
  const lotsLeft = lots.length
    ? lots.reduce((s, l) => s.plus(l.vesRemaining), new Decimal(0))
    : null;
  const plan = planById(billing?.plan ?? "negocio");
  const state = billing ? subscriptionState(billing, new Date()) : null;
  const pending = phones.filter((p) => p.status === "pending").length;
  const active = phones.filter((p) => p.status === "active").length;
  const item = (
    href: string,
    icon: React.ReactNode,
    title: string,
    sub: string,
    badge?: React.ReactNode,
  ) => (
    <a className="row" href={href}>
      <span className="ico lg">{icon}</span>
      <span className="what">
        <strong>{title}</strong>
        <span className="sub">{sub}</span>
      </span>
      <span className="amts" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {badge}
        <IconChevronRight size={18} className="muted" />
      </span>
    </a>
  );
  return (
    <div className="stack">
      <section className="card rate">
        <span className="avatar lg">{tenant.name.charAt(0).toUpperCase()}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {tenant.name}
          </h2>
          <p className="sub admin-plan-line" style={{ margin: 0 }}>
            {BUSINESS_TYPE_LABELS[settings?.businessType ?? "other"]}
            <span className={`plan-chip ${planClass(plan.id)}`}>{plan.name}</span>
          </p>
        </div>
      </section>
      <div className="card tight">
        <a className="row" href="/ajustes/plan">
          <span className="ico lg">
            <IconCard />
          </span>
          <span className="what">
            <strong>Mi plan</strong>
            <span className={`sub ${state ? dueClass(state) : ""}`}>
              {state ? dueText(state) : plan.name}
            </span>
          </span>
          <span className="amts" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <IconChevronRight size={18} className="muted" />
          </span>
        </a>
        {item("/ajustes/perfil", <IconUser />, "Perfil", `Tu nombre · ${user.email}`)}
      </div>
      <div className="card tight">
        {item("/ajustes/negocio", <IconStore />, "Negocio", "Nombre, tipo y moneda de los gastos")}
        {item(
          "/ajustes/cuentas",
          <IconWallet />,
          "Cuentas",
          accounts.length
            ? accounts.map((a) => a.name).join(" · ")
            : "Banco, Binance, Zelle, efectivo: cuánto hay en cada una",
        )}
        {item(
          "/ajustes/cambios",
          <IconSwap />,
          "Cambios USDT",
          lotsLeft === null
            ? "Si cobras en USDT y pagas en Bs"
            : `Te quedan ${formatMoney(lotsLeft, "VES")} de tus cambios`,
        )}
        {item(
          "/ajustes/categorias",
          <IconTags />,
          "Categorías de gasto",
          "Crear, renombrar o desactivar",
        )}
        {item(
          "/ajustes/numeros",
          <IconPhone />,
          "Números de WhatsApp",
          pending > 0
            ? `${active} activo${active === 1 ? "" : "s"} · ${pending} sin vincular`
            : active === 1
              ? "1 número activo"
              : `${active} números activos`,
          pending > 0 ? <span className="badge warn">{pending}</span> : undefined,
        )}
        {item(
          "/ajustes/exportar",
          <IconDownload />,
          "Exportar a Excel",
          "Un archivo por rango de fechas",
        )}
      </div>
      <div className="card tight">
        <div className="row">
          <span className="ico lg" style={{ color: "var(--muted)" }}>
            <IconUser />
          </span>
          <span className="what">
            <strong>Cuenta</strong>
            <span className="sub">{user.email}</span>
          </span>
          <form action="/auth/logout" method="post">
            <button className="btn secondary small" type="submit">
              <IconLogout size={16} />
              Salir
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
