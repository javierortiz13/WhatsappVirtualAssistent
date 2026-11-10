import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./admin.css";
import { getAdmin, getFunnel, getPayments } from "./data";
import { toContact } from "./derive";
import { AdminShell } from "./ui/shell";

export const metadata: Metadata = { title: "Administración", robots: { index: false } };
export const dynamic = "force-dynamic";

/**
 * Consola de la plataforma (rediseño 08/11): menú lateral en escritorio y pestañas arriba en el
 * teléfono, con lo pendiente contado en Pagos y Registro. Solo admins.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await getAdmin();
  const [payments, funnel] = await Promise.all([getPayments(), getFunnel()]);
  return (
    <AdminShell
      counts={{ pagos: payments.pending.length, registro: toContact(funnel.abandoned).length }}
    >
      {children}
    </AdminShell>
  );
}
