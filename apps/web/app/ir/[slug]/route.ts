import { NextResponse } from "next/server";
import { LINKS } from "../links";

export const dynamic = "force-dynamic";

/** `/ir/<slug>` → destino con UTM. Slug desconocido → portada sin parámetros. */
export function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  return ctx.params.then(({ slug }) => {
    const key = slug.toLowerCase();
    const link = Object.hasOwn(LINKS, key) ? LINKS[key] : undefined;
    const url = new URL(link?.to ?? "/", req.url);
    if (link) {
      url.searchParams.set("utm_source", link.source);
      url.searchParams.set("utm_medium", link.medium);
      url.searchParams.set("utm_campaign", link.campaign);
      url.searchParams.set("utm_content", slug.toLowerCase());
    }
    return NextResponse.redirect(url, 302);
  });
}
