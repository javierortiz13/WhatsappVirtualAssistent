"use server";

import { removeDashboardMember } from "@caja/core";
import { withTenant } from "@caja/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";

const RemoveForm = z.object({ user_id: z.string().uuid() });

/** «Quitar acceso» al panel (seguridad F3). Solo el dueño; nunca a sí mismo. */
export async function removeMemberAction(formData: FormData): Promise<void> {
  const { user, tenant } = await requireTenant();
  if (tenant.role !== "owner") redirect("/ajustes/panel?error=permiso");
  const parsed = RemoveForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/ajustes/panel?error=datos");
  const removed = await withTenant(db(), tenant.id, (tx) =>
    removeDashboardMember(tx, { tenantId: tenant.id, actorUserId: user.id }, parsed.data.user_id),
  );
  revalidatePath("/ajustes/panel");
  redirect(removed ? "/ajustes/panel?ok=quitado" : "/ajustes/panel?error=datos");
}
