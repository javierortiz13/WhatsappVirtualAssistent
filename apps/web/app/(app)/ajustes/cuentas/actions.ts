"use server";

import {
  AccountError,
  type AccountKind,
  archiveAccount,
  asIsoDate,
  createAccount,
  createTransfer,
  Decimal,
  deleteTransfer,
  implausibleExchangeRate,
  listAccounts,
  parseVenezuelanAmount,
  TransferError,
  transferAmounts,
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

const TransferForm = z.object({
  from: z.string().uuid(),
  to: z.string().uuid(),
  amount: z.string().max(30),
  received: z.string().max(30).optional(),
  fee: z.string().max(30).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const TRANSFER_ERRORS: Record<string, string> = {
  same_account: "misma",
  use_exchange: "cambio",
  missing: "datos",
  invalid: "monto",
  in_use: "usada",
};

/** Transferir entre cuentas (0014): misma moneda, o Bs → dólares (comprar USDT). */
export async function createTransferAction(formData: FormData): Promise<void> {
  const { user, tenant } = await requireTenant();
  if (tenant.role !== "owner") redirect(`${BACK}?error=permiso`);
  const parsed = TransferForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`${BACK}?error=datos`);
  const f = parsed.data;
  if (f.date > todayInCaracas()) redirect(`${BACK}?error=fecha`);
  const amount = balance(f.amount);
  const received = f.received?.trim() ? balance(f.received) : null;
  const fee = f.fee?.trim() ? balance(f.fee) : null;
  if (!amount?.gt(0) || (f.received?.trim() && !received?.gt(0)) || fee?.lt(0))
    redirect(`${BACK}?error=monto`);
  let error: string | null = null;
  await withTenant(db(), tenant.id, async (tx) => {
    const accounts = await listAccounts(tx, tenant.id);
    const from = accounts.find((a) => a.id === f.from);
    const to = accounts.find((a) => a.id === f.to);
    if (!from || !to) {
      error = "datos";
      return;
    }
    const amounts = transferAmounts(from, to, {
      fromAmount: amount,
      toAmount: received,
      rate: null,
    });
    if (amounts === "use_exchange") {
      error = "cambio";
      return;
    }
    if (!amounts) {
      error = "recibido";
      return;
    }
    if (from.currency !== to.currency) {
      const absurd = await implausibleExchangeRate(
        tx,
        amounts.fromAmount.div(amounts.toAmount),
        asIsoDate(f.date),
      );
      if (absurd) {
        error = "tasa";
        return;
      }
    }
    try {
      await createTransfer(tx, {
        tenantId: tenant.id,
        fromAccountId: from.id,
        toAccountId: to.id,
        fromAmount: amounts.fromAmount,
        toAmount: amounts.toAmount,
        fee: fee?.gt(0) ? fee : null,
        businessDate: asIsoDate(f.date),
        description: null,
        actor: { userId: user.id },
        channel: "dashboard",
      });
    } catch (err) {
      if (err instanceof TransferError) error = TRANSFER_ERRORS[err.code] ?? "datos";
      else throw err;
    }
  }).catch((err) => {
    console.error(JSON.stringify({ level: "error", msg: "transferir", detail: String(err) }));
    error = "servidor";
  });
  if (error) redirect(`${BACK}?error=${error}`);
  revalidatePath("/ajustes", "layout");
  redirect(`${BACK}?ok=transferida`);
}

const DeleteTransferForm = z.object({ id: z.string().uuid(), back: z.string().uuid() });

/** Borrar una transferencia desde el estado de cuenta. */
export async function deleteTransferAction(formData: FormData): Promise<void> {
  const { user, tenant } = await requireTenant();
  const parsed = DeleteTransferForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`${BACK}?error=datos`);
  const back = `${BACK}/${parsed.data.back}`;
  if (tenant.role !== "owner") redirect(`${back}?error=permiso`);
  let error: string | null = null;
  try {
    await withTenant(db(), tenant.id, (tx) =>
      deleteTransfer(tx, {
        tenantId: tenant.id,
        transferId: parsed.data.id,
        actor: { userId: user.id },
        now: new Date(),
      }),
    );
  } catch (err) {
    if (err instanceof TransferError) error = TRANSFER_ERRORS[err.code] ?? "datos";
    else {
      console.error(
        JSON.stringify({ level: "error", msg: "borrar transferencia", detail: String(err) }),
      );
      error = "servidor";
    }
  }
  if (error) redirect(`${back}?error=${error}`);
  revalidatePath("/ajustes", "layout");
  redirect(`${back}?ok=borrada`);
}
