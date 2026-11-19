import { adminPhone } from "@/lib/admin";
import { parsePhoneRef } from "@/lib/phone";

/**
 * «Escribirle» del admin (A-2, 19/11): comprueba el admin, busca el número en el servidor y manda
 * a wa.me. Así el número completo no queda en el HTML de la página. Sin caché.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ ref: string[] }> },
): Promise<Response> {
  const ref = parsePhoneRef((await params).ref);
  const headers = { "Cache-Control": "private, no-store" };
  if (!ref) return new Response("No encontrado", { status: 404, headers });
  const e164 = await adminPhone(ref);
  if (!e164) return new Response("No encontrado", { status: 404, headers });
  return new Response(null, {
    status: 302,
    headers: { ...headers, Location: `https://wa.me/${e164.replace(/\D/g, "")}` },
  });
}
