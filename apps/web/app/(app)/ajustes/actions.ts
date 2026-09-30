"use server";

import { addEmployee, PhoneTakenError, setPhoneStatus } from "@caja/core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { toE164 } from "@/lib/phone";
import { requireTenant } from "@/lib/session";

const AddForm = z.object({
  country: z.string().min(1).max(4),
  phone: z.string().min(6).max(24),
  name: z.string().trim().max(60).optional(),
});

/** Alta de un empleado (US-A4). Solo el dueño del dashboard. */
export async function addEmployeeAction(formData: FormData): Promise<void> {
  const { user, tenant } = await requireTenant();
  if (tenant.role !== "owner") redirect("/ajustes?error=permiso");
  const parsed = AddForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/ajustes?error=datos");
  const e164 = toE164(parsed.data.country, parsed.data.phone);
  if (!e164) redirect("/ajustes?error=telefono");
  try {
    await addEmployee(
      db(),
      { tenantId: tenant.id, userId: user.id },
      { e164, displayName: parsed.data.name || null },
    );
  } catch (err) {
    if (err instanceof PhoneTakenError) redirect("/ajustes?error=ocupado");
    console.error(JSON.stringify({ level: "error", msg: "alta empleado", detail: String(err) }));
    redirect("/ajustes?error=servidor");
  }
  revalidatePath("/ajustes");
  redirect("/ajustes?ok=alta");
}

const StatusForm = z.object({
  phone_id: z.string().uuid(),
  status: z.enum(["active", "disabled"]),
});

export async function setPhoneStatusAction(formData: FormData): Promise<void> {
  const { user, tenant } = await requireTenant();
  if (tenant.role !== "owner") redirect("/ajustes?error=permiso");
  const parsed = StatusForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/ajustes?error=datos");
  await setPhoneStatus(
    db(),
    { tenantId: tenant.id, userId: user.id },
    parsed.data.phone_id,
    parsed.data.status,
  );
  revalidatePath("/ajustes");
  redirect("/ajustes");
}
