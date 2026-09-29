import type { AuthError, EmailOtpType } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Valida el magic link (POST desde la página de confirmación). Acepta las dos formas que emite
 * Supabase: `token_hash` + `type` (plantilla con {{ .TokenHash }}, sirve desde otro dispositivo)
 * y `code` (flujo PKCE por defecto, solo desde el navegador que pidió el enlace).
 */
export async function POST(req: Request) {
  const form = await req.formData();
  const tokenHash = String(form.get("token_hash") ?? "");
  const type = String(form.get("type") ?? "") as EmailOtpType | "";
  const code = String(form.get("code") ?? "");
  const supabase = await supabaseServer();

  let error: Pick<AuthError, "message" | "status" | "code"> | null = null;
  if (tokenHash && type) {
    ({ error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type }));
  } else if (code) {
    ({ error } = await supabase.auth.exchangeCodeForSession(code));
  } else {
    error = { message: "sin token ni code", status: undefined, code: undefined };
  }
  if (error) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "confirm",
        flow: tokenHash ? "token_hash" : code ? "code" : "none",
        status: error.status ?? null,
        code: error.code ?? null,
        detail: error.message,
      }),
    );
  }
  const origin = new URL(req.url).origin;
  return NextResponse.redirect(new URL(error ? "/login?error=enlace" : "/inicio", origin), {
    status: 303,
  });
}
