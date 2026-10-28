import "server-only";
import { eq, rows, schema, sql, withTenant } from "@caja/db";
import { redirect } from "next/navigation";
import { cache } from "react";
import { assertDbRole, db } from "./db";
import { supabaseServer } from "./supabase/server";

export type Session = {
  user: { id: string; email: string };
  tenant: { id: string; name: string; status: string; role: string } | null;
};

type MembershipRow = {
  tenant_id: string;
  role: string;
  tenant_name: string;
  tenant_status: string;
};

/**
 * Sesión del dashboard: usuario de Supabase Auth vinculado a `user_account` (claim en cada
 * petición, idempotente) y su primer negocio. Sin sesión devuelve null. Cacheado por petición.
 */
export const currentSession = cache(async (): Promise<Session | null> => {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return null;
  await assertDbRole();
  const conn = db();
  await conn.execute(sql`select app.claim_account(${user.id}::uuid, ${user.email})`);
  const memberships = rows<MembershipRow>(
    await conn.execute(sql`select * from app.memberships_for_user(${user.id}::uuid)`),
  );
  const first = memberships[0];
  return {
    user: { id: user.id, email: user.email },
    tenant: first
      ? {
          id: first.tenant_id,
          name: first.tenant_name,
          status: first.tenant_status,
          role: first.role,
        }
      : null,
  };
});

/** Exige sesión y negocio; si falta uno, redirige. Para las páginas privadas. */
export async function requireTenant(): Promise<
  Session & { tenant: NonNullable<Session["tenant"]> }
> {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (!session.tenant) redirect("/registro");
  return { ...session, tenant: session.tenant };
}

/**
 * ¿Es una cuenta personal? Una persona no vende: el panel dice "Ingresos" y los agrupa por fuente
 * (salario, freelance…) en vez de "Ventas" por método (19/10). Cacheado por petición.
 */
export const isPersonalTenant = cache(async (tenantId: string): Promise<boolean> => {
  const [row] = await withTenant(db(), tenantId, (tx) =>
    tx
      .select({ businessType: schema.tenant.businessType })
      .from(schema.tenant)
      .where(eq(schema.tenant.id, tenantId)),
  );
  return row?.businessType === "personal";
});
