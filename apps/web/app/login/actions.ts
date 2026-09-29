"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { env } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";

const Email = z.string().trim().toLowerCase().email();

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
    console.error(JSON.stringify({ level: "error", msg: "magic link", code: error.code }));
    redirect(error.status === 429 ? "/login?error=espera" : "/login?error=envio");
  }
  redirect("/login?enviado=1");
}
