import "server-only";
import {
  Decimal,
  latestRates,
  type MonthUsage,
  monthUsage,
  planById,
  type SubscriptionState,
  subscriptionState,
  type TenantPhone,
  tenantPhones,
} from "@caja/core";
import { and, desc, eq, everyTenantId, schema, withTenant } from "@caja/db";
import { notFound, redirect } from "next/navigation";
import { db } from "./db";
import { env } from "./env";
import { currentSession } from "./session";

/**
 * Panel de administración de la plataforma (fase 1 de cobros, 02/10/2026). Solo entran los
 * correos de PLATFORM_ADMIN_EMAILS. Recorre los negocios uno a uno bajo RLS (`withTenant`), igual
 * que el housekeeping: no hay claves de administrador en el navegador ni lecturas sin tenant.
 */
export type Admin = { userId: string; email: string };

export function adminEmails(): string[] {
  return (env().PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export async function requireAdmin(): Promise<Admin> {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (!adminEmails().includes(session.user.email.toLowerCase())) notFound();
  return { userId: session.user.id, email: session.user.email };
}

export type TenantRow = {
  id: string;
  name: string;
  businessType: string;
  plan: string;
  planPrice: number;
  cap: number;
  status: string;
  createdAt: Date;
  state: SubscriptionState;
  owner: TenantPhone | null;
  usage: MonthUsage;
  pendingPayments: number;
  /** Parte del costo de Meta que le toca este mes (solo lo que pasa del cupo gratis). */
  metaCostUsd: Decimal;
  /** Ingreso del mes: precio del plan si está pagado; 0 en prueba, cortesía o suspendido. */
  revenueUsd: Decimal;
  marginUsd: Decimal;
};

const FREE_TIER = 1000;

export async function loadTenants(now: Date): Promise<TenantRow[]> {
  // Defensa en profundidad: el layout no se vuelve a renderizar en cada navegación.
  await requireAdmin();
  const conn = db();
  const ids = await everyTenantId(conn);
  const base = [];
  for (const id of ids) {
    base.push(
      await withTenant(conn, id, async (tx) => {
        const [t] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, id));
        const phones = await tenantPhones(tx, id);
        const usage = await monthUsage(tx, id, now);
        const pendingCount = (
          await tx
            .select({ status: schema.payment.status })
            .from(schema.payment)
            .where(eq(schema.payment.tenantId, id))
        ).filter((p) => p.status === "pending").length;
        return t ? { t, phones, usage, pendingCount } : null;
      }),
    );
  }
  const present = base.filter((b): b is NonNullable<typeof b> => b !== null);
  // Meta cobra por número de la plataforma: el excedente del mes se reparte por salientes.
  const totalOut = present.reduce((n, b) => n + b.usage.outbound, 0);
  const metaTotal = new Decimal(Math.max(totalOut - FREE_TIER, 0)).mul(env().META_MSG_RATE_USD);
  return present.map(({ t, phones, usage, pendingCount }) => {
    const plan = planById(t.plan);
    const state = subscriptionState(t, now);
    const paying = t.status === "active" && t.paidUntil !== null && state.kind !== "expired";
    const revenue = new Decimal(paying ? plan.priceUsd : 0);
    const meta = totalOut ? metaTotal.mul(usage.outbound).div(totalOut) : new Decimal(0);
    return {
      id: t.id,
      name: t.name,
      businessType: t.businessType,
      plan: t.plan,
      planPrice: plan.priceUsd,
      cap: plan.messagesPerMonth,
      status: t.status,
      createdAt: t.createdAt,
      state,
      owner: phones.find((p) => p.role === "owner") ?? null,
      usage,
      pendingPayments: pendingCount,
      metaCostUsd: meta.toDecimalPlaces(4),
      revenueUsd: revenue,
      marginUsd: revenue.minus(usage.aiCostUsd).minus(meta).toDecimalPlaces(2),
    };
  });
}

export type PendingPayment = typeof schema.payment.$inferSelect & { tenantName: string };

export async function loadPendingPayments(): Promise<PendingPayment[]> {
  // Defensa en profundidad: el layout no se vuelve a renderizar en cada navegación.
  await requireAdmin();
  const conn = db();
  const out: PendingPayment[] = [];
  for (const id of await everyTenantId(conn)) {
    const rows = await withTenant(conn, id, async (tx) => {
      const [t] = await tx
        .select({ name: schema.tenant.name })
        .from(schema.tenant)
        .where(eq(schema.tenant.id, id));
      const list = await tx
        .select()
        .from(schema.payment)
        .where(eq(schema.payment.tenantId, id))
        .orderBy(desc(schema.payment.createdAt));
      return list
        .filter((p) => p.status === "pending")
        .map((p) => ({ ...p, tenantName: t?.name ?? "?" }));
    });
    out.push(...rows);
  }
  return out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export async function loadTenantDetail(tenantId: string, now: Date) {
  // Defensa en profundidad: el layout no se vuelve a renderizar en cada navegación.
  await requireAdmin();
  const conn = db();
  if (!(await everyTenantId(conn)).includes(tenantId)) notFound();
  return withTenant(conn, tenantId, async (tx) => {
    const [t] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId));
    if (!t) notFound();
    const [phones, usage, payments, history] = await Promise.all([
      tenantPhones(tx, tenantId),
      monthUsage(tx, tenantId, now),
      tx
        .select()
        .from(schema.payment)
        .where(eq(schema.payment.tenantId, tenantId))
        .orderBy(desc(schema.payment.createdAt)),
      tx
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.tenantId, tenantId), eq(schema.auditLog.channel, "admin")))
        .orderBy(desc(schema.auditLog.createdAt))
        .limit(20),
    ]);
    const system = await tx
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.tenantId, tenantId), eq(schema.auditLog.action, "suspend_expired")),
      )
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(5);
    return {
      tenant: t,
      plan: planById(t.plan),
      state: subscriptionState(t, now),
      phones,
      usage,
      payments,
      history: [...history, ...system].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      ),
    };
  });
}

export async function loadRates() {
  // Defensa en profundidad: el layout no se vuelve a renderizar en cada navegación.
  await requireAdmin();
  return latestRates(db());
}
