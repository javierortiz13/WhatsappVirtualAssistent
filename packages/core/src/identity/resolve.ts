import { type Queryable, rows, schema, sql } from "@caja/db";
import type { Sender } from "../whatsapp/types.js";

export type ResolvedSender = {
  phoneId: string;
  tenantId: string;
  role: "owner" | "employee";
  phoneStatus: "pending" | "active" | "disabled";
  tenantStatus: "trial" | "active" | "suspended";
};

type ResolveRow = {
  phone_id: string;
  tenant_id: string;
  role: string;
  status: string;
  tenant_status: string;
};

/**
 * Resuelve quién escribe antes de conocer el tenant, vía la función SECURITY DEFINER
 * `app.resolve_phone`. Devuelve null si el número (o el BSUID) no existe.
 */
export async function resolveSender(db: Queryable, sender: Sender): Promise<ResolvedSender | null> {
  const found = rows<ResolveRow>(
    await db.execute(sql`select * from app.resolve_phone(${sender.e164}, ${sender.waUserId})`),
  );
  const r = found[0];
  if (!r) return null;
  return {
    phoneId: r.phone_id,
    tenantId: r.tenant_id,
    role: r.role as ResolvedSender["role"],
    phoneStatus: r.status as ResolvedSender["phoneStatus"],
    tenantStatus: r.tenant_status as ResolvedSender["tenantStatus"],
  };
}

export function canUse(r: ResolvedSender): boolean {
  return r.phoneStatus === "active" && r.tenantStatus !== "suspended";
}

/**
 * Rate limit para desconocidos: `max` mensajes por ventana, luego silencio. Sin contenido.
 * Devuelve true si toca responder.
 */
export async function allowUnknownReply(
  db: Queryable,
  key: string,
  opts: { max: number; windowMs: number; now: Date },
): Promise<boolean> {
  const windowStart = new Date(opts.now.getTime() - opts.windowMs);
  const t = schema.unknownSenderHit;
  const result = rows<{ hits: number }>(
    await db.execute(sql`
      insert into ${t} (e164, hits, window_start)
      values (${key}, 1, ${opts.now})
      on conflict (e164) do update set
        hits = case when ${t}.window_start < ${windowStart} then 1 else ${t}.hits + 1 end,
        window_start = case when ${t}.window_start < ${windowStart} then ${opts.now} else ${t}.window_start end
      returning hits
    `),
  );
  return (result[0]?.hits ?? Number.POSITIVE_INFINITY) <= opts.max;
}
