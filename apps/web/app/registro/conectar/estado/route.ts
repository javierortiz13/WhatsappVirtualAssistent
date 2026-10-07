import { NextResponse } from "next/server";
import { currentSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ¿Ya quedó conectado el panel a un negocio? Para el polling de /registro/conectar. */
export async function GET() {
  const session = await currentSession();
  if (!session) return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  return NextResponse.json(
    { status: session.tenant ? "active" : "waiting" },
    { headers: { "cache-control": "no-store" } },
  );
}
