"use server";

import { ownerPhone, setDashboardPref } from "@caja/core";
import { withTenant } from "@caja/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";

/** Interruptores de avisos (hábitos US-205): solo el dueño, sobre su propio teléfono. */
const BACK = "/ajustes/avisos";

export async function setPrefAction(formData: FormData): Promise<void> {
  const { user, tenant } = await requireTenant();
  if (tenant.role !== "owner") redirect(`${BACK}?error=permiso`);
  const which = formData.get("which");
  const on = formData.get("on") === "1";
  if (which !== "nudge" && which !== "unsolicited") redirect(`${BACK}?error=invalid`);
  const phone = await ownerPhone(db(), tenant.id);
  if (!phone) redirect(`${BACK}?error=sin_telefono`);
  const err = await withTenant(db(), tenant.id, (tx) =>
    setDashboardPref(
      tx,
      { tenantId: tenant.id, phoneId: phone.id, userId: user.id, now: new Date() },
      which,
      on,
    ),
  );
  revalidatePath(BACK);
  redirect(err ? `${BACK}?error=${err}` : `${BACK}?ok=${which}_${on ? "on" : "off"}`);
}
