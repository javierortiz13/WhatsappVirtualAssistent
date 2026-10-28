import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { PRIVACY_BANNER_COOKIE } from "@/lib/privacy-banner";
import { requireTenant } from "@/lib/session";
import { shellProps } from "@/lib/shell";
import { PrivacyBanner } from "./privacy-banner";
import { Shell } from "./sidebar";

/**
 * Layout privado: exige sesión con negocio y monta el menú lateral con la tasa del día. El dueño ve
 * el aviso de la política nueva (H53b, US-200) hasta que lo cierra.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await requireTenant();
  const banner = session.tenant.role === "owner" && !(await cookies()).get(PRIVACY_BANNER_COOKIE);
  return (
    <Shell {...(await shellProps(session))}>
      {banner ? <PrivacyBanner /> : null}
      {children}
    </Shell>
  );
}
