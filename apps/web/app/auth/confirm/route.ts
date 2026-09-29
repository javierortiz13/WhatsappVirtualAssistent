import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Destino del magic link. Acepta las dos formas que emite Supabase:
 * - `token_hash` + `type` (plantilla de correo con {{ .TokenHash }}; funciona desde otro dispositivo).
 * - `code` (flujo PKCE por defecto; solo desde el mismo navegador que pidió el enlace).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const code = url.searchParams.get("code");
  const supabase = await supabaseServer();

  let ok = false;
  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    ok = !error;
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    ok = !error;
  }
  const dest = new URL(ok ? "/inicio" : "/login?error=enlace", url.origin);
  return NextResponse.redirect(dest);
}
