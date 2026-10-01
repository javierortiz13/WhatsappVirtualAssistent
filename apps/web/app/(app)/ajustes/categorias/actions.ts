"use server";

import { CategoryError, createCategory, renameCategory, setCategoryActive } from "@caja/core";
import { withTenant } from "@caja/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";

const BACK = "/ajustes/categorias";

function fail(err: unknown): never {
  const code = err instanceof CategoryError ? err.code : "servidor";
  redirect(`${BACK}?error=${code}`);
}

async function owner() {
  const { user, tenant } = await requireTenant();
  if (tenant.role !== "owner") redirect(`${BACK}?error=permiso`);
  return { tenantId: tenant.id, userId: user.id };
}

export async function createCategoryAction(formData: FormData): Promise<void> {
  const ref = await owner();
  const name = z.string().max(60).safeParse(formData.get("name"));
  if (!name.success) redirect(`${BACK}?error=invalid`);
  try {
    await withTenant(db(), ref.tenantId, (tx) => createCategory(tx, ref, name.data));
  } catch (err) {
    fail(err);
  }
  revalidatePath(BACK);
  redirect(`${BACK}?ok=creada`);
}

export async function renameCategoryAction(formData: FormData): Promise<void> {
  const ref = await owner();
  const p = z
    .object({ id: z.string().uuid(), name: z.string().max(60) })
    .safeParse(Object.fromEntries(formData));
  if (!p.success) redirect(`${BACK}?error=invalid`);
  try {
    await withTenant(db(), ref.tenantId, (tx) => renameCategory(tx, ref, p.data.id, p.data.name));
  } catch (err) {
    fail(err);
  }
  revalidatePath(BACK);
  redirect(`${BACK}?ok=guardada`);
}

export async function setCategoryActiveAction(formData: FormData): Promise<void> {
  const ref = await owner();
  const p = z
    .object({ id: z.string().uuid(), active: z.enum(["1", "0"]) })
    .safeParse(Object.fromEntries(formData));
  if (!p.success) redirect(`${BACK}?error=invalid`);
  try {
    await withTenant(db(), ref.tenantId, (tx) =>
      setCategoryActive(tx, ref, p.data.id, p.data.active === "1"),
    );
  } catch (err) {
    fail(err);
  }
  revalidatePath(BACK);
  redirect(BACK);
}
