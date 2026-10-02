import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requireAdmin } from "@/lib/admin";
import { currentSession } from "@/lib/session";
import { shellProps } from "@/lib/shell";
import { Shell } from "../(app)/sidebar";

export const metadata: Metadata = { title: "Administración", robots: { index: false } };
export const dynamic = "force-dynamic";

/** Consola de la plataforma con el mismo menú lateral del dashboard, más ancha. Solo admins. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireAdmin();
  const session = await currentSession();
  if (!session) return null;
  return (
    <Shell {...(await shellProps(session))} wide>
      {children}
    </Shell>
  );
}
