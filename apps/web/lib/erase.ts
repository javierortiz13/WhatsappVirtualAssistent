import "server-only";
import { cleanupErased, eraseTenant, SupabaseAuthAdmin, SupabaseStorage } from "@caja/core";
import { withTenant } from "@caja/db";
import { db } from "./db";
import { env } from "./env";

/** El nombre escrito para confirmar coincide con el del negocio (sin mayúsculas ni espacios de más). */
export function confirmsName(typed: unknown, name: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase("es");
  return typeof typed === "string" && typed.trim() !== "" && norm(typed) === norm(name);
}

/**
 * Elimina un negocio por completo (0017) y limpia lo que vive fuera de la base: las fotos del
 * bucket y los usuarios del panel que se quedaron sin negocio. Quién puede pedirlo lo decide el
 * que llama (dueño o administrador).
 */
export async function eraseBusiness(tenantId: string) {
  const erased = await withTenant(db(), tenantId, (tx) => eraseTenant(tx, tenantId));
  const e = env();
  const key = e.SUPABASE_SERVICE_ROLE_KEY;
  const cleaned = await cleanupErased(erased, {
    store: key
      ? new SupabaseStorage({
          url: e.NEXT_PUBLIC_SUPABASE_URL,
          serviceKey: key,
          bucket: e.STORAGE_BUCKET,
        })
      : null,
    auth: key ? new SupabaseAuthAdmin({ url: e.NEXT_PUBLIC_SUPABASE_URL, serviceKey: key }) : null,
  });
  console.info(JSON.stringify({ level: "info", msg: "negocio eliminado", tenantId, ...cleaned }));
  return cleaned;
}
