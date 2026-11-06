import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Proxy (antes middleware): refresca la sesión de Supabase en cada petición y manda a /login a
 * quien entre sin sesión a una ruta privada. El webhook de Meta no pasa por aquí.
 */
const PRIVATE_PREFIXES = [
  "/admin",
  "/inicio",
  "/movimientos",
  "/cierres",
  "/ajustes",
  "/registro",
  "/adjuntos",
  "/exportar",
  "/sin-negocio",
  /** P4 (SEC-P4-4): los puntos del dueño. */
  "/logros",
];

export async function proxy(request: NextRequest) {
  // Invitaciones (P4-B, US-420, PV-7, SEC-P4-12): `?ref=` nunca se queda en la URL. 302 a la misma
  // URL sin `ref` (del mismo sitio, desde `nextUrl.clone()`), pasando por /api/ref, que pone la
  // cookie solo con `referrals` encendido. La portada sigue estática y sin Set-Cookie.
  const ref = request.nextUrl.searchParams.get("ref");
  if (ref !== null) {
    const clean = request.nextUrl.clone();
    clean.searchParams.delete("ref");
    const hop = request.nextUrl.clone();
    hop.pathname = "/api/ref";
    hop.search = "";
    hop.searchParams.set("code", ref.slice(0, 12));
    hop.searchParams.set("next", `${clean.pathname}${clean.search}`);
    const res = NextResponse.redirect(hop, 302);
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  }
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;
  const isPrivate = PRIVATE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
  if (!user && isPrivate) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    return NextResponse.redirect(login);
  }
  if (user && path === "/login") {
    const home = request.nextUrl.clone();
    home.pathname = "/inicio";
    home.search = "";
    return NextResponse.redirect(home);
  }
  return response;
}

export const config = {
  // `/w` y `/w/CODE` (SEC-P4-10 b) no pasan por aquí: un tráfico grande ahí no se vuelve llamadas
  // de sesión a Supabase.
  matcher: [
    "/((?!api/|_next/|monitoring|w/|w$|favicon.ico|icon.svg|manifest.webmanifest|.*\\..*).*)",
  ],
};
