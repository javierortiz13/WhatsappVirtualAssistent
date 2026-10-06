"use server";

import {
  addEmployee,
  BUSINESS_TYPE_LABELS,
  CategoryError,
  PhoneTakenError,
  setPhoneStatus,
  updateTenantSettings,
} from "@caja/core";
import { withTenant } from "@caja/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { confirmsName, eraseBusiness } from "@/lib/erase";
import { toE164 } from "@/lib/phone";
import { requireTenant } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";

const AddForm = z.object({
  country: z.string().min(1).max(4),
  phone: z.string().min(6).max(24),
  name: z.string().trim().max(60).optional(),
});

/** Alta de un empleado (US-A4). Solo el dueño del dashboard. */
export async function addEmployeeAction(formData: FormData): Promise<void> {
  const { user, tenant } = await requireTenant();
  if (tenant.role !== "owner") redirect("/ajustes/numeros?error=permiso");
  const parsed = AddForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/ajustes/numeros?error=datos");
  const e164 = toE164(parsed.data.country, parsed.data.phone);
  if (!e164) redirect("/ajustes/numeros?error=telefono");
  try {
    await addEmployee(
      db(),
      { tenantId: tenant.id, userId: user.id },
      { e164, displayName: parsed.data.name || null },
    );
  } catch (err) {
    if (err instanceof PhoneTakenError) redirect("/ajustes/numeros?error=ocupado");
    console.error(JSON.stringify({ level: "error", msg: "alta empleado", detail: String(err) }));
    redirect("/ajustes/numeros?error=servidor");
  }
  revalidatePath("/ajustes/numeros");
  redirect("/ajustes/numeros?ok=alta");
}

const StatusForm = z.object({
  phone_id: z.string().uuid(),
  status: z.enum(["active", "disabled"]),
});

export async function setPhoneStatusAction(formData: FormData): Promise<void> {
  const { user, tenant } = await requireTenant();
  if (tenant.role !== "owner") redirect("/ajustes/numeros?error=permiso");
  const parsed = StatusForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/ajustes/numeros?error=datos");
  await setPhoneStatus(
    db(),
    { tenantId: tenant.id, userId: user.id },
    parsed.data.phone_id,
    parsed.data.status,
  );
  revalidatePath("/ajustes/numeros");
  redirect("/ajustes/numeros");
}

const SettingsForm = z.object({
  name: z.string().trim().min(2).max(80),
  business_type: z.enum(Object.keys(BUSINESS_TYPE_LABELS) as [string, ...string[]]),
  currency: z.enum(["USD", "VES"]),
  bs_rate_mode: z.enum(["bcv", "usdt", "ask"]).default("bcv"),
});

/** Nombre, tipo y moneda por defecto del negocio (US-E7). Solo el dueño. */
export async function updateSettingsAction(formData: FormData): Promise<void> {
  const { user, tenant } = await requireTenant();
  if (tenant.role !== "owner") redirect("/ajustes/negocio?error=permiso");
  const parsed = SettingsForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/ajustes/negocio?error=datos");
  try {
    await withTenant(db(), tenant.id, (tx) =>
      updateTenantSettings(
        tx,
        { tenantId: tenant.id, userId: user.id },
        {
          name: parsed.data.name,
          businessType: parsed.data.business_type as keyof typeof BUSINESS_TYPE_LABELS,
          defaultExpenseCurrency: parsed.data.currency,
          bsRateMode: parsed.data.bs_rate_mode,
        },
      ),
    );
  } catch (err) {
    if (err instanceof CategoryError) redirect("/ajustes/negocio?error=datos");
    console.error(JSON.stringify({ level: "error", msg: "ajustes", detail: String(err) }));
    redirect("/ajustes/negocio?error=servidor");
  }
  revalidatePath("/", "layout");
  redirect("/ajustes/negocio?ok=negocio");
}

/**
 * Eliminar mi cuenta (0017, lo promete /eliminar-datos): el dueño borra el negocio por completo
 * escribiendo su nombre. Después se cierra la sesión: el usuario del panel ya no existe.
 */
export async function eraseMyBusinessAction(formData: FormData): Promise<void> {
  const { tenant } = await requireTenant();
  if (tenant.role !== "owner") redirect("/ajustes/negocio?error=permiso");
  if (!confirmsName(formData.get("confirm"), tenant.name))
    redirect("/ajustes/negocio?error=confirmar#eliminar");
  try {
    await eraseBusiness(tenant.id);
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "eliminar negocio", detail: String(err) }));
    redirect("/ajustes/negocio?error=servidor#eliminar");
  }
  try {
    await (await supabaseServer()).auth.signOut();
  } catch {
    // El usuario ya no existe en Auth: basta con que se borren las cookies.
  }
  redirect("/login?eliminada=1");
}
