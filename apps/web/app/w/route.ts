import { type NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { cleanCode, REF_COOKIE, referralsOn, waLink } from "@/lib/referral";

/**
 * El botón de WhatsApp de la portada (US-420): la portada es estática, así que pasa por aquí.
 * Con `referrals` y la cookie `rocco_ref`, WhatsApp abre con «Hola Rocco, me invitó CODE»; si
 * no, el mismo enlace de siempre («Hola Rocco» con sus UTM). Una cookie que no valida se borra.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const wa = env().PLATFORM_WA_NUMBER;
  if (!wa) return NextResponse.redirect(new URL("/", request.nextUrl.origin), 302);
  const raw = request.cookies.get(REF_COOKIE)?.value ?? null;
  const on = raw !== null && (await referralsOn());
  const code = on ? cleanCode(raw) : null;
  const res = NextResponse.redirect(waLink(wa, code, true), 302);
  res.headers.set("Cache-Control", "private, no-store");
  if (on && raw !== null && !code) res.cookies.delete(REF_COOKIE);
  return res;
}
