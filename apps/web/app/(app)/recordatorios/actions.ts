"use server";

import {
  cancelReminder,
  Decimal,
  dueAtOn,
  getReminder,
  type IsoDate,
  isPositiveAmount,
  markReminderDone,
  parseVenezuelanAmount,
  type ReminderChange,
  updateReminder,
} from "@caja/core";
import { withTenant } from "@caja/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";

/**
 * Acciones de la página Recordatorios (hábitos US-309). Solo el dueño. Cada cambio deja en
 * `audit_log` solo los nombres de los campos (F3-4 (3)); Borrar quita el texto, el monto y la
 * contraparte al instante (F3-4 (1)).
 */
const BACK = "/recordatorios";

async function owner() {
  const { user, tenant } = await requireTenant();
  if (tenant.role !== "owner") redirect(`${BACK}?error=permiso`);
  return { tenantId: tenant.id, userId: user.id };
}

const Id = z.object({ id: z.string().uuid() });

export async function markDoneAction(formData: FormData): Promise<void> {
  const ref = await owner();
  const p = Id.safeParse(Object.fromEntries(formData));
  if (!p.success) redirect(`${BACK}?error=invalid`);
  const done = await withTenant(db(), ref.tenantId, async (tx) => {
    const r = await getReminder(tx, ref.tenantId, p.data.id);
    if (!r?.text || r.status === "done" || r.status === "cancelled") return false;
    await markReminderDone(tx, r, { userId: ref.userId }, new Date(), null, "dashboard");
    return true;
  });
  revalidatePath(BACK);
  redirect(`${BACK}?${done ? "ok=hecho" : "error=invalid"}`);
}

export async function deleteReminderAction(formData: FormData): Promise<void> {
  const ref = await owner();
  const p = Id.safeParse(Object.fromEntries(formData));
  if (!p.success) redirect(`${BACK}?error=invalid`);
  await withTenant(db(), ref.tenantId, async (tx) => {
    const r = await getReminder(tx, ref.tenantId, p.data.id);
    if (r && r.status !== "cancelled")
      await cancelReminder(tx, r, { userId: ref.userId }, new Date(), "dashboard");
  });
  revalidatePath(BACK);
  redirect(`${BACK}?ok=borrado`);
}

const Edit = z.object({
  id: z.string().uuid(),
  text: z.string().trim().min(1).max(80),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  amount: z.string().trim().max(30),
  currency: z.enum(["USD", "VES", "EUR"]),
});

export async function editReminderAction(formData: FormData): Promise<void> {
  const ref = await owner();
  const p = Edit.safeParse(Object.fromEntries(formData));
  if (!p.success) redirect(`${BACK}?error=invalid`);
  const amount = p.data.amount
    ? (parseVenezuelanAmount(p.data.amount) ??
      (/^\d+(\.\d+)?$/.test(p.data.amount) ? new Decimal(p.data.amount) : null))
    : null;
  if (p.data.amount && (!amount || !isPositiveAmount(amount))) redirect(`${BACK}?error=monto`);
  const now = new Date();
  const result = await withTenant(db(), ref.tenantId, async (tx) => {
    const r = await getReminder(tx, ref.tenantId, p.data.id);
    if (!r?.text || r.status === "done" || r.status === "cancelled" || r.status === "expired")
      return "invalid";
    const change: ReminderChange = {};
    if (p.data.text !== r.text) change.text = p.data.text;
    const newAmount = amount ? amount.toFixed(2) : null;
    if (newAmount !== r.amount || (newAmount && p.data.currency !== r.currency)) {
      change.amount = newAmount;
      change.currency = newAmount ? p.data.currency : null;
    }
    // Hora de Caracas: el formulario muestra la del recordatorio y solo cuenta si cambió.
    const local = new Date(r.dueAt.getTime() - 4 * 3_600_000).toISOString();
    if (p.data.date !== local.slice(0, 10) || p.data.time !== local.slice(11, 16)) {
      const [h, m] = p.data.time.split(":").map(Number) as [number, number];
      const due = dueAtOn(p.data.date as IsoDate, h, m, now, false);
      if (due.kind !== "ok") return "fecha";
      change.dueAt = due.dueAt;
      change.dueDate = due.dueDate;
      change.timeWasDefault = false;
    }
    if (Object.keys(change).length)
      await updateReminder(tx, r, change, { userId: ref.userId }, now, "dashboard");
    return "ok";
  });
  revalidatePath(BACK);
  redirect(result === "ok" ? `${BACK}?ok=editado` : `${BACK}?error=${result}`);
}
