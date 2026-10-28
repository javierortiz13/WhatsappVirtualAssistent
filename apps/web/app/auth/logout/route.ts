import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { isCrossSite } from "@/lib/same-origin";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Seguridad F4: un sitio ajeno no puede cerrar la sesión.
  const allowed = new URL(env().DASHBOARD_URL).origin;
  if (isCrossSite(req, allowed))
    return NextResponse.redirect(new URL("/login", allowed), { status: 303 });
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", new URL(req.url).origin), { status: 303 });
}
