import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Vuelta de Google (OAuth vía Supabase): canjea el `code` por la sesión con el verificador PKCE
 * de la cookie. Sin negocio todavía, /inicio manda a /registro como con el magic link.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  // El usuario canceló en Google o el proveedor devolvió un error: vuelve al login sin ruido.
  const denied = url.searchParams.get("error");
  let failed = !code;
  if (code) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      failed = true;
      console.error(
        JSON.stringify({
          level: "error",
          msg: "google callback",
          status: error.status ?? null,
          code: error.code ?? null,
          detail: error.message,
        }),
      );
    }
  }
  const target = failed ? `/login?error=${denied ? "google_cancelado" : "google"}` : "/inicio";
  return NextResponse.redirect(new URL(target, url.origin), { status: 303 });
}
