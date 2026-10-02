import type { ReactNode } from "react";
import { requireTenant } from "@/lib/session";
import { shellProps } from "@/lib/shell";
import { Shell } from "./sidebar";

/** Layout privado: exige sesión con negocio y monta el menú lateral con la tasa del día. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await requireTenant();
  return <Shell {...(await shellProps(session))}>{children}</Shell>;
}
