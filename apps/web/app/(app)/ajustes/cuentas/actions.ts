"use server";

import {
  AccountError,
  type AccountKind,
  archiveAccount,
  asIsoDate,
  createAccount,
  Decimal,
  parseVenezuelanAmount,
  updateAccount,
} from "@caja/core";
import { withTenant } from "@caja/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { todayInCaracas } from "@/lib/queries";
import { requireTenant } from "@/lib/session";

const BACK = "/ajustes/cuentas";

/**
 * Un saldo como lo escribe una persona en Venezuela: "49.250" son 49 mil, "1.250,50" lleva coma
 * decimal; si no, "1250.50" con punto. Vacío es cero. Admite negativo (una cuenta en rojo).
 */
function balance(raw: string | undefined): Decimal | null {
  const t = (raw ?? "").trim();
  if (!t) return new Decimal(0);
  const neg = t.startsWith("-");
  const body = neg ? t.slice(1).trim() : t;
  const d = parseVenezuelanAmount(body) ?? (/^\d+(\.\d+)?$/.test(body) ? new Decimal(body) : null);
  if (!d) return null;
  return neg ? d.neg() : d;
}

const KINDS = ["bank", "cash", "zelle", "crypto", "other"] as const;

const AddForm = z.object({
  name: z.string().trim().min(1).max(40),
  currency: z.enum(["VES", "USD", "USDT"]),
  kind: z.enum(KINDS),
  opening: z.string().max(30).optional(),
});

function fail(err: unknown, what: string): never {
  if (err instanceof AccountError)
    redirect(
      `${BACK}?error=${err.code === "duplicate" ? "repetida" : err.code === "too_many" ? "tope" : "datos"}`,
    );
  console.error(JSON.stringify({ level: "error", msg: what, detail: String(err) }));
  redirect(`${BACK}?error=servidor`);
}

/** Crear una cuenta (0013). Solo el dueño. USDT es una cuenta en dólares de tipo Binance. */
export async function createAccountAction(formData: FormData): Promise<void> {
  const { user, tenant } = await requireTenant();
  if (tenant.role !== "owner") redirect(`${BACK}?error=permiso`);
  const parsed = AddForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`${BACK}?error=datos`);
  const opening = balance(parsed.data.opening);
  if (!opening) redirect(`${BACK}?error=saldo`);
  const kind: AccountKind = parsed.data.currency === "USDT" ? "crypto" : parsed.data.kind;
  try {
    await withTenant(db(), tenant.id, (tx) =>
      createAccount(tx, {
        tenantId: tenant.id,
        name: parsed.data.name,
        currency: parsed.data.currency === "VES" ? "VES" : "USD",
        kind,
        openingBalance: opening,
        openingDate: asIsoDate(todayInCaracas()),
        actor: { userId: user.id },
        channel: "dashboard",
      }),
    );
  } catch (err) {
    fail(err, "crear cuenta");
  }
  revalidatePath("/ajustes", "layout");
  redirect(`${BACK}?ok=creada`);
}

const EditForm = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(40),
  opening: z.string().max(30).optional(),
});

/** Renombrar o cambiar el saldo inicial (en Bs ajusta su lote a la BCV del día de apertura). */
export async function updateAccountAction(formData: FormData): Promise<void> {
  const { user, tenant } = await requireTenant();
  if (tenant.role !== "owner") redirect(`${BACK}?error=permiso`);
  const parsed = EditForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`${BACK}?error=datos`);
  const opening = balance(parsed.data.opening);
  if (!opening) redirect(`${BACK}?error=saldo`);
  try {
    await withTenant(db(), tenant.id, (tx) =>
      updateAccount(tx, {
        tenantId: tenant.id,
        accountId: parsed.data.id,
        name: parsed.data.name,
        openingBalance: opening,
        actor: { userId: user.id },
      }),
    );
  } catch (err) {
    fail(err, "editar cuenta");
  }
  revalidatePath("/ajustes", "layout");
  redirect(`${BACK}?ok=editada`);
}

const ArchiveForm = z.object({ id: z.string().uuid() });

/** Archivar: deja de ofrecerse y de sumar en el total; sus movimientos quedan como están. */
export async function archiveAccountAction(formData: FormData): Promise<void> {
  const { user, tenant } = await requireTenant();
  if (tenant.role !== "owner") redirect(`${BACK}?error=permiso`);
  const parsed = ArchiveForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`${BACK}?error=datos`);
  try {
    await withTenant(db(), tenant.id, (tx) =>
      archiveAccount(tx, {
        tenantId: tenant.id,
        accountId: parsed.data.id,
        actor: { userId: user.id },
        now: new Date(),
      }),
    );
  } catch (err) {
    fail(err, "archivar cuenta");
  }
  revalidatePath("/ajustes", "layout");
  redirect(`${BACK}?ok=archivada`);
}
