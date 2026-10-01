import { sql } from "drizzle-orm";
import { type Queryable, rows } from "./client";

/** Ids de todos los tenants activos, vía `app.all_tenant_ids` (SECURITY DEFINER). Para jobs de mantenimiento. */
export async function allTenantIds(db: Queryable): Promise<string[]> {
  return rows<{ id: string }>(await db.execute(sql`select * from app.all_tenant_ids() as id`)).map(
    (r) => r.id,
  );
}
