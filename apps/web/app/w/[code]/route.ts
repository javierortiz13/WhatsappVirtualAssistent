import { type NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { cleanCode, referralsOn, waLink } from "@/lib/referral";

/**
 * `holarocco.com/w/CODE` (RW6-wa, US-420, SEC-P4-10): 302 a WhatsApp con «Hola Rocco, me invitó
 * CODE» para cualquier código con la forma de §P4.7, exista o no (el chat lo valida en silencio,
 * SEC-P4-2); con otra cosa, o con `referrals` apagado, «Hola Rocco». El enlace sale de
 * `PLATFORM_WA_NUMBER` y del código ya validado (nunca de la ruta tal cual). Sin cookie.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const wa = env().PLATFORM_WA_NUMBER;
  if (!wa) return NextResponse.redirect(new URL("/", request.nextUrl.origin), 302);
  const { code: raw } = await params;
  let decoded: string | null = null;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = null;
  }
  const code = (await referralsOn()) ? cleanCode(decoded) : null;
  const res = NextResponse.redirect(waLink(wa, code, false), 302);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
