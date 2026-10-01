import { BUSINESS_TYPE_LABELS, getTenantSettings, tenantPhones } from "@caja/core";
import { withTenant } from "@caja/db";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";
import {
  IconChevronRight,
  IconDownload,
  IconLogout,
  IconPhone,
  IconStore,
  IconTags,
  IconUser,
} from "../icons";

export const metadata: Metadata = { title: "Ajustes" };
export const dynamic = "force-dynamic";

/** Portada de ajustes: una tarjeta por sección. Cada una vive en su propia página. */
export default async function Ajustes() {
  const { user, tenant } = await requireTenant();
  const { phones, settings } = await withTenant(db(), tenant.id, async (tx) => ({
    phones: await tenantPhones(tx, tenant.id),
    settings: await getTenantSettings(tx, tenant.id),
  }));
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
          <p className="sub" style={{ margin: 0 }}>
            {BUSINESS_TYPE_LABELS[settings?.businessType ?? "other"]} ·{" "}
            {tenant.status === "trial" ? "en prueba" : tenant.status}
          </p>
        </div>
      </section>
      <div className="card tight">
        {item("/ajustes/negocio", <IconStore />, "Negocio", "Nombre, tipo y moneda de los gastos")}
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
