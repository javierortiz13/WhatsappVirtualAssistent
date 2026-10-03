import { SupabaseStorage } from "@caja/core";
import { and, eq, isNull, schema, withTenant } from "@caja/db";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { requireTenant } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Foto de factura del negocio de la sesión: URL firmada de 10 minutos y redirección. El bucket es
 * privado; RLS acota la fila al tenant y la clave service_role no sale del servidor.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { tenant } = await requireTenant();
  const { id } = await ctx.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    return new NextResponse("No encontrado", { status: 404 });
  const e = env();
  if (!e.SUPABASE_SERVICE_ROLE_KEY)
    return new NextResponse("Las fotos no están configuradas en este servidor.", { status: 503 });
  const [row] = await withTenant(db(), tenant.id, (tx) =>
    tx
      .select({ key: schema.attachment.storageKey })
      .from(schema.attachment)
      .where(and(eq(schema.attachment.id, id), isNull(schema.attachment.deletedAt))),
  );
  if (!row) return new NextResponse("No encontrado", { status: 404 });
  const store = new SupabaseStorage({
    url: e.NEXT_PUBLIC_SUPABASE_URL,
    serviceKey: e.SUPABASE_SERVICE_ROLE_KEY,
    bucket: e.STORAGE_BUCKET,
  });
  const url = await store.signedUrl(row.key, 600);
  return NextResponse.redirect(url, { status: 302, headers: { "cache-control": "no-store" } });
}
