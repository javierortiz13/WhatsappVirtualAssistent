"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { env } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";

const Email = z.string().trim().toLowerCase().email();

/**
 * Entrar con Google (OAuth de Supabase, flujo PKCE): el verificador queda en una cookie y
 * /auth/callback lo canjea por la sesión. La misma cuenta sirve con magic link o con Google si el
 * correo es el mismo (Supabase vincula identidades con correo verificado).
 */
export async function signInWithGoogle(): Promise<void> {
  if (!env().GOOGLE_AUTH_ENABLED) redirect("/login");
  const h = await headers();
  const origin = h.get("origin") ?? env().DASHBOARD_URL;
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${origin}/auth/callback`, queryParams: { prompt: "select_account" } },
  });
  if (error || !data.url) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "google oauth",
        status: error?.status ?? null,
        code: error?.code ?? null,
        detail: error?.message ?? "sin url",
      }),
    );
    redirect("/login?error=google");
  }
  redirect(data.url);
}

/** Envía el magic link. Nunca revela si el correo existe: la respuesta es la misma. */
export async function sendMagicLink(formData: FormData): Promise<void> {
  const parsed = Email.safeParse(formData.get("email"));
  if (!parsed.success) redirect("/login?error=correo");
  const h = await headers();
  const origin = h.get("origin") ?? env().DASHBOARD_URL;
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data,
    options: { emailRedirectTo: `${origin}/auth/confirm`, shouldCreateUser: true },
  });
  if (error) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "magic link",
        status: error.status ?? null,
        code: error.code ?? null,
        detail: error.message,
      }),
    );
    redirect(error.status === 429 ? "/login?error=espera" : "/login?error=envio");
  }
  redirect("/login?enviado=1");
}
