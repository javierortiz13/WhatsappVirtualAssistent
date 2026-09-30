import { ownerPhone } from "@caja/core";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Estado del número del dueño, para el polling de la pantalla de vinculación. */
export async function GET() {
  const session = await currentSession();
  if (!session) return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  if (!session.tenant) return NextResponse.json({ status: "no_tenant" });
  const owner = await ownerPhone(db(), session.tenant.id);
  return NextResponse.json(
    { status: owner?.status ?? "missing" },
    { headers: { "cache-control": "no-store" } },
  );
}
