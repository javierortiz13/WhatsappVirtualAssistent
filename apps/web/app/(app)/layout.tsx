import { getRateInfo, tenantPhones } from "@caja/core";
import { formatMoney } from "@caja/core/domain";
import { withTenant } from "@caja/db";
import type { ReactNode } from "react";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { todayInCaracas } from "@/lib/queries";
import { requireTenant } from "@/lib/session";
import { Shell } from "./sidebar";

/** Layout privado: exige sesión con negocio y monta el menú lateral con la tasa del día. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await requireTenant();
  const today = todayInCaracas();
  const [rate, phones] = await Promise.all([
    getRateInfo(db(), today),
    withTenant(db(), session.tenant.id, (tx) => tenantPhones(tx, session.tenant.id)),
  ]);
  const wa = env().PLATFORM_WA_NUMBER;
  return (
    <Shell
      tenantName={session.tenant.name}
      email={session.user.email}
      rateLine={
        rate.current ? `BCV ${formatMoney(rate.current.value, "VES").replace("Bs ", "")}` : null
      }
      pendingPhones={phones.filter((p) => p.status === "pending").length}
      assistantUrl={wa ? `https://wa.me/${wa}` : null}
    >
      {children}
    </Shell>
  );
}
