"use server";

import { redirect } from "next/navigation";
import { restoreBusiness } from "@/lib/erase";
import { currentSession } from "@/lib/session";

/** Saca el negocio de la papelera (0017). Solo el dueño. */
export async function restoreMyBusinessAction(): Promise<void> {
  const session = await currentSession();
  if (!session) redirect("/login");
  const t = session.tenant;
  if (t?.status !== "deleted") redirect("/inicio");
  if (t.role !== "owner") redirect("/recuperar?error=permiso");
  try {
    await restoreBusiness(t.id, { type: "user", id: session.user.id }, "dashboard");
  } catch (err) {
    console.error(
      JSON.stringify({ level: "error", msg: "recuperar negocio", detail: String(err) }),
    );
    redirect("/recuperar?error=servidor");
  }
  redirect("/inicio?recuperada=1");
}
