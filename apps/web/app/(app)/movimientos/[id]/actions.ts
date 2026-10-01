"use server";

import {
  type AmendChanges,
  amendMovement,
  computeAmend,
  deleteMovement,
  isIsoDate,
  PAYMENT_METHOD_LABELS,
  type PaymentMethod,
} from "@caja/core";
import { asIsoDate, Decimal } from "@caja/core/domain";
import { and, eq, isNull, schema, withTenant } from "@caja/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";

const UUID = z.string().uuid();

const Form = z.object({
  id: UUID,
  amount: z.string().trim().min(1),
  currency: z.enum(["USD", "VES"]),
  business_date: z.string(),
  category_id: z.string().optional(),
  description: z.string().trim().max(200).optional(),
  payment_method: z.string().optional(),
});

/** Edición desde el dashboard (US-E2): mismas reglas que la corrección por chat, con auditoría. */
export async function updateMovementAction(formData: FormData): Promise<void> {
  const { user, tenant } = await requireTenant();
  const parsed = Form.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/movimientos?error=datos");
  const f = parsed.data;
  const back = `/movimientos/${f.id}`;
  const amount = new Decimal(f.amount.replace(",", "."));
  if (!amount.isFinite() || amount.lte(0)) redirect(`${back}?error=monto`);
  if (!isIsoDate(f.business_date)) redirect(`${back}?error=fecha`);
  const method = f.payment_method ?? "";
  if (method && !(method in PAYMENT_METHOD_LABELS)) redirect(`${back}?error=datos`);

  const result = await withTenant(db(), tenant.id, async (tx) => {
    const [m] = await tx
      .select()
      .from(schema.movement)
      .where(and(eq(schema.movement.id, f.id), isNull(schema.movement.deletedAt)));
    if (!m) return "missing" as const;
    let categoryId: string | null | undefined;
    let categoryName: string | null | undefined;
    if (m.type === "expense") {
      const wanted = f.category_id || null;
      if (wanted && !UUID.safeParse(wanted).success) return "datos" as const;
      if (wanted !== m.categoryId) {
        if (wanted) {
          const [c] = await tx
            .select({ id: schema.category.id, name: schema.category.name })
            .from(schema.category)
            .where(and(eq(schema.category.id, wanted), eq(schema.category.tenantId, tenant.id)));
          if (!c) return "datos" as const;
          categoryId = c.id;
          categoryName = c.name;
        } else {
          categoryId = null;
          categoryName = null;
        }
      }
    }
    const [current] = m.categoryId
      ? await tx
          .select({ name: schema.category.name })
          .from(schema.category)
          .where(eq(schema.category.id, m.categoryId))
      : [];
    const changes: AmendChanges = {
      amount,
      currency: f.currency,
      businessDate: asIsoDate(f.business_date),
      description: f.description || null,
      ...(categoryId !== undefined ? { categoryId, categoryName: categoryName ?? null } : {}),
      ...(m.type === "income" && method ? { paymentMethod: method as PaymentMethod } : {}),
    };
    const draft = await computeAmend(tx, {
      movement: m,
      categoryName: current?.name ?? null,
      changes,
    });
    if (draft.changed.length === 0) return "nochange" as const;
    const now = new Date();
    const after = await amendMovement(tx, {
      tenantId: tenant.id,
      draft,
      actor: { userId: user.id },
      now,
    });
    return after
      ? { rateChanged: draft.before.rateValue !== draft.after.rateValue }
      : ("missing" as const);
  });
  if (result === "missing") redirect("/movimientos?error=noexiste");
  if (result === "datos") redirect(`${back}?error=datos`);
  revalidatePath("/movimientos");
  revalidatePath("/inicio");
  revalidatePath("/cierres");
  if (result === "nochange") redirect(`${back}?ok=igual`);
  redirect(`${back}?ok=${result.rateChanged ? "tasa" : "guardado"}`);
}

export async function deleteMovementAction(formData: FormData): Promise<void> {
  const { user, tenant } = await requireTenant();
  const id = UUID.safeParse(formData.get("id"));
  if (!id.success) redirect("/movimientos?error=datos");
  const gone = await withTenant(db(), tenant.id, (tx) =>
    deleteMovement(tx, {
      tenantId: tenant.id,
      movementId: id.data,
      actor: { userId: user.id },
      now: new Date(),
    }),
  );
  if (!gone) redirect("/movimientos?error=noexiste");
  revalidatePath("/movimientos");
  revalidatePath("/inicio");
  revalidatePath("/cierres");
  redirect(`/movimientos?mes=${gone.businessDate.slice(0, 7)}&ok=eliminado`);
}
