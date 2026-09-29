import type { Metadata } from "next";
import { requireTenant } from "@/lib/session";

export const metadata: Metadata = { title: "Ajustes" };

export default async function Ajustes() {
  const { user, tenant } = await requireTenant();
  return (
    <div className="stack">
      <div className="card stack">
        <div>
          <p className="kpi-label">Negocio</p>
          <p style={{ margin: 0, fontWeight: 600 }}>{tenant.name}</p>
          <p className="kpi-sub">Estado: {tenant.status}</p>
        </div>
        <div>
          <p className="kpi-label">Cuenta</p>
          <p style={{ margin: 0 }}>{user.email}</p>
        </div>
      </div>
      <div className="card">
        <p className="kpi-label">Categorías, números y exportación</p>
        <p style={{ margin: 0 }} className="muted">
          Llegan en los próximos sprints.
        </p>
      </div>
      <form action="/auth/logout" method="post">
        <button className="btn secondary" type="submit">
          Cerrar sesión
        </button>
      </form>
    </div>
  );
}
