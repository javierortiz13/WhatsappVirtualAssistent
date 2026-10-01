import { isIsoDate } from "@caja/core/domain";
import { NextResponse } from "next/server";
import { buildWorkbook, exportFilename } from "@/lib/export";
import { exportRows } from "@/lib/queries";
import { requireTenant } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DAYS = 366;

/** `GET /exportar?desde=YYYY-MM-DD&hasta=YYYY-MM-DD` → .xlsx del negocio de la sesión (US-E3). */
export async function GET(req: Request) {
  const { tenant } = await requireTenant();
  const url = new URL(req.url);
  const from = url.searchParams.get("desde") ?? "";
  const to = url.searchParams.get("hasta") ?? "";
  if (!isIsoDate(from) || !isIsoDate(to) || from > to)
    return new NextResponse("Rango inválido. Usa desde=YYYY-MM-DD&hasta=YYYY-MM-DD.", {
      status: 400,
    });
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (days > MAX_DAYS) return new NextResponse("Máximo 12 meses por archivo.", { status: 400 });
  const rows = await exportRows(tenant.id, from, to);
  const buf = await buildWorkbook(rows, { tenantName: tenant.name, from, to });
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${exportFilename(tenant.name, from, to)}"`,
      "cache-control": "no-store",
    },
  });
}
