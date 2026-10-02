import "server-only";
import { getRateInfo, subscriptionState, tenantPhones } from "@caja/core";
import { formatMoney } from "@caja/core/domain";
import { eq, schema, withTenant } from "@caja/db";
import type { SidebarProps } from "@/app/(app)/sidebar";
import { adminEmails } from "./admin";
import { db } from "./db";
import { env } from "./env";
import { todayInCaracas } from "./queries";
import type { Session } from "./session";

/** Etiqueta corta del plan para el menú: solo cuando hay algo que mirar (prueba o vencimiento). */
export function planBadge(
  t: { status: string; trialEndsAt: Date | null; paidUntil: Date | null },
  now: Date,
): { text: string; warn: boolean } | null {
  const s = subscriptionState(t, now);
  const d = s.daysLeft ?? 0;
  if (s.kind === "suspended") return { text: "suspendido", warn: true };
  if (s.kind === "grace" || s.kind === "expired") return { text: "vencido", warn: true };
  if (s.kind === "trial") return { text: `prueba · ${Math.max(d, 0)} d`, warn: d <= 3 };
  if (s.endsAt && d <= 5) return { text: `vence en ${Math.max(d, 0)} d`, warn: true };
  return null;
}

/** Datos del menú lateral, compartidos por el dashboard y la consola de administración. */
export async function shellProps(session: Session): Promise<Omit<SidebarProps, "wide">> {
  const today = todayInCaracas();
  const rate = await getRateInfo(db(), today);
  const tenant = session.tenant;
  const extra = tenant
    ? await withTenant(db(), tenant.id, async (tx) => {
        const [t] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenant.id));
        const phones = await tenantPhones(tx, tenant.id);
        return { t, phones };
      })
    : null;
  const wa = env().PLATFORM_WA_NUMBER;
  return {
    tenantName: tenant?.name ?? "Plataforma",
    email: session.user.email,
    rateLine: rate.current
      ? `BCV ${formatMoney(rate.current.value, "VES").replace("Bs ", "")}`
      : null,
    pendingPhones: extra?.phones.filter((p) => p.status === "pending").length ?? 0,
    assistantUrl: wa ? `https://wa.me/${wa}` : null,
    isAdmin: adminEmails().includes(session.user.email.toLowerCase()),
    planBadge: extra?.t ? planBadge(extra.t, new Date()) : null,
  };
}
