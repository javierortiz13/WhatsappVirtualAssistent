import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requireAdmin } from "@/lib/admin";

export const metadata: Metadata = { title: "Administración", robots: { index: false } };
export const dynamic = "force-dynamic";

/** Panel de la plataforma: fuera del menú de los negocios y solo para PLATFORM_ADMIN_EMAILS. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const admin = await requireAdmin();
  return (
    <div className="content wide">
      <header className="topbar admin-top">
        <h1>
          <a href="/admin">Administración</a>
        </h1>
        <span className="sub">{admin.email}</span>
        <a className="linkbtn" href="/inicio">
          Mi negocio
        </a>
      </header>
      {children}
    </div>
  );
}
