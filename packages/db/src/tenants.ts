import { sql } from "drizzle-orm";
import { type Queryable, rows } from "./client";

/** Ids de todos los tenants activos, vía `app.all_tenant_ids` (SECURITY DEFINER). Para jobs de mantenimiento. */
export async function allTenantIds(db: Queryable): Promise<string[]> {
  return rows<{ id: string }>(await db.execute(sql`select * from app.all_tenant_ids() as id`)).map(
    (r) => r.id,
  );
}

/** Ids de todos los tenants, suspendidos incluidos (`app.every_tenant_id`). Para cobros y el panel. */
export async function everyTenantId(db: Queryable): Promise<string[]> {
  return rows<{ id: string }>(await db.execute(sql`select * from app.every_tenant_id() as id`)).map(
    (r) => r.id,
  );
}

/**
 * Negocios con borradores vencidos (`app.due_draft_tenant_ids`, 0022). La fecha va como ISO:
 * postgres-js no serializa un `Date` en SQL crudo.
 */
export async function dueDraftTenantIds(db: Queryable, at: Date): Promise<string[]> {
  return rows<{ id: string }>(
    await db.execute(
      sql`select * from app.due_draft_tenant_ids(${at.toISOString()}::timestamptz) as id`,
    ),
  ).map((r) => r.id);
}
