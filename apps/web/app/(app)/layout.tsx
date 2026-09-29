import type { ReactNode } from "react";
import { requireTenant } from "@/lib/session";
import { Nav } from "./nav";

/** Layout privado: exige sesión con negocio; barra inferior en móvil, lateral en escritorio. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await requireTenant();
  return (
    <div className="shell">
      <Nav />
      <main className="content">
        <div className="topbar">
          <h1>{session.tenant.name}</h1>
          <span className="biz">{session.user.email}</span>
        </div>
        {children}
      </main>
    </div>
  );
}
