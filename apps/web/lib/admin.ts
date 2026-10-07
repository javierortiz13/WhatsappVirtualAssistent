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
  trialSpend,
} from "@caja/core";
import { and, desc, eq, everyTenantId, gte, rows, schema, sql, withTenant } from "@caja/db";
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
  /** En la papelera (0017): cuándo se borra para siempre. */
  purgeAfter: Date | null;
  owner: TenantPhone | null;
  usage: MonthUsage;
  pendingPayments: number;
  /** Parte del costo de Meta que le toca este mes (solo lo que pasa del cupo gratis). */
  metaCostUsd: Decimal;
  /** Ingreso del mes: precio del plan si está pagado; 0 en prueba, cortesía o suspendido. */
  revenueUsd: Decimal;
  marginUsd: Decimal;
  /** CRM (0019). */
  signupChannel: string;
  founderUntil: string | null;
  crmTags: string[];
  survey: Record<string, string>;
  lastInboundAt: Date | null;
  /** Movimientos en las primeras 24 h: 3 o más = activado. */
  firstDayMovements: number;
  health: Health;
};

/** Semáforo del CRM: escribió hace 2 días o menos, hasta 6, o más (o nunca). */
export type Health = "green" | "amber" | "red";
export function healthOf(last: Date | null, now: Date): Health {
  if (!last) return "red";
  const days = (now.getTime() - last.getTime()) / 86_400_000;
  return days <= 2 ? "green" : days <= 6 ? "amber" : "red";
}

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
        if (!t) return null;
        const [act] = rows<{ last_in: string | null; first_day: number | string }>(
          await tx.execute(sql`
            select (select max(created_at) from app.message
                     where tenant_id = ${id} and direction = 'in')::text as last_in,
                   (select count(*) from app.movement
                     where tenant_id = ${id} and deleted_at is null
                       and created_at < ${new Date(t.createdAt.getTime() + 86_400_000).toISOString()}::timestamptz
                   ) as first_day
          `),
        );
        return {
          t,
          phones,
          usage,
          pendingCount,
          lastInboundAt: act?.last_in ? new Date(act.last_in) : null,
          firstDayMovements: Number(act?.first_day ?? 0),
        };
      }),
    );
  }
  const present = base.filter((b): b is NonNullable<typeof b> => b !== null);
  // Meta cobra por número de la plataforma: el excedente del mes se reparte por salientes.
  const totalOut = present.reduce((n, b) => n + b.usage.outbound, 0);
  const metaTotal = new Decimal(Math.max(totalOut - FREE_TIER, 0)).mul(env().META_MSG_RATE_USD);
  return present.map(({ t, phones, usage, pendingCount, lastInboundAt, firstDayMovements }) => {
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
      cap: plan.messagesPerMonth + (t.extraMonth === usage.month ? t.extraMessages : 0),
      status: t.status,
      createdAt: t.createdAt,
      state,
      purgeAfter: t.deletedAt ? t.purgeAfter : null,
      owner: phones.find((p) => p.role === "owner") ?? null,
      usage,
      pendingPayments: pendingCount,
      metaCostUsd: meta.toDecimalPlaces(4),
      revenueUsd: revenue,
      marginUsd: revenue.minus(usage.aiCostUsd).minus(meta).toDecimalPlaces(2),
      signupChannel: t.signupChannel,
      founderUntil: t.founderUntil,
      crmTags: t.crmTags,
      survey: (t.survey ?? {}) as Record<string, string>,
      lastInboundAt,
      firstDayMovements,
      health: healthOf(lastInboundAt, now),
    };
  });
}

export type AbandonedSignup = {
  e164: string;
  name: string | null;
  step: string;
  messages: number;
  updatedAt: Date;
};

/**
 * Embudo del CRM (0019): registros por WhatsApp (empezados, terminados, abandonados) y, sobre los
 * negocios, cuántos se activaron, siguen activos y pagan. `signup` es global (sin RLS).
 */
export async function loadFunnel(tenants: TenantRow[], now: Date) {
  await requireAdmin();
  const s = schema.signup;
  const all = await db()
    .select()
    .from(s)
    .where(gte(s.createdAt, new Date(now.getTime() - 90 * 86_400_000)))
    .orderBy(desc(s.updatedAt));
  const live = tenants.filter((t) => !t.purgeAfter);
  const abandoned: AbandonedSignup[] = all
    .filter((r) => !r.completedAt && now.getTime() - r.updatedAt.getTime() > 30 * 60_000)
    .slice(0, 20)
    .map((r) => ({
      e164: r.e164,
      name: ((r.data ?? {}) as { name?: string }).name ?? r.profileName,
      step: r.step,
      messages: r.messages,
      updatedAt: r.updatedAt,
    }));
  return {
    chatStarted: all.length,
    chatCompleted: all.filter((r) => r.completedAt).length,
    webSignups: live.filter((t) => t.signupChannel === "dashboard").length,
    tenants: live.length,
    activated: live.filter((t) => t.firstDayMovements >= 3).length,
    active7: live.filter(
      (t) => t.lastInboundAt && now.getTime() - t.lastInboundAt.getTime() <= 7 * 86_400_000,
    ).length,
    paying: live.filter((t) => t.revenueUsd.gt(0)).length,
    abandoned,
  };
}

/** Respuestas de la encuesta de precio y del "¿seguimos?" (0019), contadas por opción. */
export function surveyTally(tenants: TenantRow[]) {
  const tally = (key: string) => {
    const out: Record<string, number> = {};
    for (const t of tenants) {
      const v = t.survey[key];
      if (v) out[v] = (out[v] ?? 0) + 1;
    }
    return out;
  };
  return { fair: tally("fair"), expensive: tally("expensive"), continue: tally("continue") };
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
    const [phones, usage, trial, payments, history] = await Promise.all([
      tenantPhones(tx, tenantId),
      monthUsage(tx, tenantId, now),
      trialSpend(tx, t, { metaRateUsd: env().META_MSG_RATE_USD }),
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
      trial,
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
