"use server";

import {
  asIsoDate,
  completeExchange,
  createExchangeLot,
  Decimal,
  deleteExchangeLot,
  ExchangeError,
  implausibleExchangeRate,
  parseVenezuelanAmount,
} from "@caja/core";
import { withTenant } from "@caja/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { todayInCaracas } from "@/lib/queries";
import { requireTenant } from "@/lib/session";

const BACK = "/ajustes/cambios";

/**
 * El monto o la tasa como lo escribe una persona en Venezuela: "49.250" son 49 mil, "1.250,50" y
 * "970,5" llevan coma decimal. Si no es formato venezolano, "1250.50" con punto decimal.
 */
function amount(raw: string | undefined): Decimal | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const d = parseVenezuelanAmount(t) ?? (/^\d+(\.\d+)?$/.test(t) ? new Decimal(t) : null);
  return d?.gt(0) ? d : null;
}

const AddForm = z.object({
  usd: z.string().max(30).optional(),
  ves: z.string().max(30).optional(),
  rate: z.string().max(30).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** Registrar un cambio USDT → Bs desde el dashboard (0012). Solo el dueño. */
export async function createExchangeAction(formData: FormData): Promise<void> {
  const { user, tenant } = await requireTenant();
  if (tenant.role !== "owner") redirect(`${BACK}?error=permiso`);
  const parsed = AddForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`${BACK}?error=datos`);
  if (parsed.data.date > todayInCaracas()) redirect(`${BACK}?error=fecha`);
  const ex = completeExchange({
    usd: amount(parsed.data.usd),
    ves: amount(parsed.data.ves),
    rate: amount(parsed.data.rate),
  });
  if (!ex) redirect(`${BACK}?error=datos`);
  const absurd = await withTenant(db(), tenant.id, (tx) =>
    implausibleExchangeRate(tx, ex.rate, asIsoDate(parsed.data.date)),
  );
  if (absurd) redirect(`${BACK}?error=tasa`);
  try {
    await withTenant(db(), tenant.id, (tx) =>
      createExchangeLot(tx, {
        tenantId: tenant.id,
        businessDate: parsed.data.date,
        usd: ex.usd,
        ves: ex.ves,
        rate: ex.rate,
        actor: { userId: user.id },
        channel: "dashboard",
      }),
    );
  } catch (err) {
    if (err instanceof ExchangeError) redirect(`${BACK}?error=datos`);
    console.error(JSON.stringify({ level: "error", msg: "cambio", detail: String(err) }));
    redirect(`${BACK}?error=servidor`);
  }
  revalidatePath("/ajustes", "layout");
  redirect(`${BACK}?ok=creado`);
}

const DeleteForm = z.object({ id: z.string().uuid() });

/** Borrar un cambio que ningún gasto usó. */
export async function deleteExchangeAction(formData: FormData): Promise<void> {
  const { user, tenant } = await requireTenant();
  if (tenant.role !== "owner") redirect(`${BACK}?error=permiso`);
  const parsed = DeleteForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`${BACK}?error=datos`);
  try {
    await withTenant(db(), tenant.id, (tx) =>
      deleteExchangeLot(tx, {
        tenantId: tenant.id,
        lotId: parsed.data.id,
        actor: { userId: user.id },
        now: new Date(),
      }),
    );
  } catch (err) {
    if (err instanceof ExchangeError)
      redirect(`${BACK}?error=${err.code === "in_use" ? "usado" : "datos"}`);
    console.error(JSON.stringify({ level: "error", msg: "borrar cambio", detail: String(err) }));
    redirect(`${BACK}?error=servidor`);
  }
  revalidatePath("/ajustes", "layout");
  redirect(`${BACK}?ok=borrado`);
}
