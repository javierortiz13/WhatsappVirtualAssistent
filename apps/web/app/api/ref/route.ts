import { type NextRequest, NextResponse } from "next/server";
import { cleanCode, REF_COOKIE, refCookieOptions, referralsOn, safeNext } from "@/lib/referral";

/**
 * Segundo salto de `?ref=` (US-420, DQ-P4-3, SEC-P4-12): el proxy ya quitó `ref` de la URL y
 * manda aquí el código y la ruta limpia. Con `referrals`, un código con la forma deja `rocco_ref`;
 * uno mal escrito no deja nada. Siempre el mismo 302 a la ruta limpia del mismo sitio, sin
 * guardar en caché. Ninguna respuesta dice si el código existe (SEC-P4-2).
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const target = new URL(
    safeNext(request.nextUrl.searchParams.get("next")),
    request.nextUrl.origin,
  );
  if (target.origin !== request.nextUrl.origin) target.href = request.nextUrl.origin;
  const res = NextResponse.redirect(target, 302);
  res.headers.set("Cache-Control", "private, no-store");
  const code = cleanCode(request.nextUrl.searchParams.get("code"));
  if (code && (await referralsOn())) res.cookies.set(REF_COOKIE, code, refCookieOptions);
  return res;
}
