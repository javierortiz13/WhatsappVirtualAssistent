import { and, desc, eq, isNull, schema, type Tx } from "@caja/db";
import { z } from "zod";
import { asIsoDate, type IsoDate } from "../domain/dates";
import {
  type Currency,
  convert,
  Decimal,
  money,
  type Rate,
  toDbAmount,
  toDbRate,
} from "../domain/money";
import { insertDraft } from "./drafts";
import type { Actor } from "./expenses";
import type { PaymentMethod } from "./income";
import { rateFor } from "./rate-for";

/**
 * Corregir o borrar el último movimiento por chat (US-B8). Solo el último movimiento vivo
 * creado por el mismo teléfono y con menos de 30 minutos; después, el dashboard. Ambas acciones
 * pasan por `pending_action` y se ejecutan al confirmar, con auditoría de antes y después.
 */
export const LAST_MOVEMENT_WINDOW_MS = 30 * 60 * 1000;

export type Movement = typeof schema.movement.$inferSelect;

export async function lastMovementByPhone(
  tx: Tx,
  tenantId: string,
  phoneId: string,
): Promise<Movement | null> {
  const [row] = await tx
    .select()
    .from(schema.movement)
    .where(
      and(
        eq(schema.movement.tenantId, tenantId),
        eq(schema.movement.createdByPhoneId, phoneId),
        isNull(schema.movement.deletedAt),
      ),
    )
    .orderBy(desc(schema.movement.createdAt))
    .limit(1);
  return row ?? null;
}

export function isTooOld(m: Movement, now: Date): boolean {
  return now.getTime() - m.createdAt.getTime() > LAST_MOVEMENT_WINDOW_MS;
}

/** Etiqueta corta para los mensajes: "Champú · $15,00 · hoy" o "Pago Móvil · $100,00". */
export function movementLabel(
  m: Movement,
  categoryName: string | null,
  methodLabel: string,
): string {
  const what =
    m.type === "expense"
      ? (m.description ?? categoryName ?? "Gasto")
      : (m.description ?? methodLabel);
  return what;
}

export const MovementSnapshot = z.object({
  amount: z.string(),
  currency: z.enum(["USD", "VES"]),
  amountUsd: z.string(),
  amountVes: z.string(),
  rateId: z.string().uuid().nullable(),
  rateValue: z.string(),
  rateSource: z.enum(["bcv", "manual"]),
  businessDate: z.string(),
  categoryId: z.string().uuid().nullable(),
  categoryName: z.string().nullable(),
  description: z.string().nullable(),
  paymentMethod: z.string(),
});
export type MovementSnapshot = z.infer<typeof MovementSnapshot>;

export const EditLastDraft = z.object({
  movementId: z.string().uuid(),
  type: z.enum(["expense", "income"]),
  before: MovementSnapshot,
  after: MovementSnapshot,
  changed: z.array(z.string()),
});
export type EditLastDraft = z.infer<typeof EditLastDraft>;

export const DeleteLastDraft = z.object({
  movementId: z.string().uuid(),
  type: z.enum(["expense", "income"]),
  origin: z.enum(["single", "day_total"]),
  snapshot: MovementSnapshot,
});
export type DeleteLastDraft = z.infer<typeof DeleteLastDraft>;

export type AmendChanges = {
  amount?: Decimal;
  currency?: Currency;
  categoryId?: string | null;
  categoryName?: string | null;
  description?: string | null;
  businessDate?: IsoDate;
  paymentMethod?: PaymentMethod;
  manualRate?: Rate;
};

function snapshot(m: Movement, categoryName: string | null): MovementSnapshot {
  return {
    amount: m.amount,
    currency: m.currency as Currency,
    amountUsd: m.amountUsd,
    amountVes: m.amountVes,
    rateId: m.rateId,
    rateValue: m.rateValue,
    rateSource: m.rateSource as "bcv" | "manual",
    businessDate: m.businessDate,
    categoryId: m.categoryId,
    categoryName,
    description: m.description,
    paymentMethod: m.paymentMethod,
  };
}

/**
 * Calcula el "después" de una corrección (chat o dashboard): si cambia la fecha se recalcula la
 * tasa (salvo tasa manual explícita); si cambia monto o moneda se reconvierten los equivalentes
 * con la tasa vigente del movimiento. No escribe nada.
 */
export async function computeAmend(
  tx: Tx,
  input: { movement: Movement; categoryName: string | null; changes: AmendChanges },
): Promise<EditLastDraft> {
  const m = input.movement;
  const before = snapshot(m, input.categoryName);
  const businessDate = input.changes.businessDate ?? asIsoDate(m.businessDate);
  const dateChanged = businessDate !== m.businessDate;
  let rate: Rate;
  if (input.changes.manualRate) rate = input.changes.manualRate;
  else if (dateChanged) rate = (await rateFor(tx, businessDate)).rate;
  else
    rate = {
      value: new Decimal(m.rateValue),
      effectiveDate: m.businessDate,
      id: m.rateId,
      source: m.rateSource as "bcv" | "manual",
    };
  const amount = input.changes.amount ?? new Decimal(m.amount);
  const currency = input.changes.currency ?? (m.currency as Currency);
  const c = convert(money(amount, currency), rate);
  const after: MovementSnapshot = {
    amount: toDbAmount(c.amount),
    currency: c.currency,
    amountUsd: toDbAmount(c.amountUsd),
    amountVes: toDbAmount(c.amountVes),
    rateId: rate.id,
    rateValue: toDbRate(rate.value),
    rateSource: rate.source,
    businessDate,
    categoryId: input.changes.categoryId !== undefined ? input.changes.categoryId : m.categoryId,
    categoryName:
      input.changes.categoryName !== undefined ? input.changes.categoryName : input.categoryName,
    description:
      input.changes.description !== undefined ? input.changes.description : m.description,
    paymentMethod: input.changes.paymentMethod ?? m.paymentMethod,
  };
  const changed = (Object.keys(after) as (keyof MovementSnapshot)[]).filter(
    (k) => after[k] !== before[k],
  );
  return { movementId: m.id, type: m.type as "expense" | "income", before, after, changed };
}

/** Borrador de corrección por chat: `computeAmend` más un `pending_action` de tipo `edit_last`. */
export async function createEditLastDraft(
  tx: Tx,
  input: {
    tenantId: string;
    phoneId: string;
    movement: Movement;
    categoryName: string | null;
    changes: AmendChanges;
  },
  now: Date,
): Promise<{ pendingId: string; draft: EditLastDraft; replacedPrevious: boolean }> {
  const draft = await computeAmend(tx, input);
  const r = await insertDraft(
    tx,
    { tenantId: input.tenantId, phoneId: input.phoneId, kind: "edit_last", payload: draft },
    now,
  );
  return { ...r, draft };
}

export async function createDeleteLastDraft(
  tx: Tx,
  input: { tenantId: string; phoneId: string; movement: Movement; categoryName: string | null },
  now: Date,
): Promise<{ pendingId: string; draft: DeleteLastDraft; replacedPrevious: boolean }> {
  const draft: DeleteLastDraft = {
    movementId: input.movement.id,
    type: input.movement.type as "expense" | "income",
    origin: input.movement.origin as "single" | "day_total",
    snapshot: snapshot(input.movement, input.categoryName),
  };
  const r = await insertDraft(
    tx,
    { tenantId: input.tenantId, phoneId: input.phoneId, kind: "delete_last", payload: draft },
    now,
  );
  return { ...r, draft };
}

async function audit(
  tx: Tx,
  tenantId: string,
  actor: Actor,
  action: "update" | "delete",
  before: Movement,
  after: Movement,
) {
  await tx.insert(schema.auditLog).values({
    tenantId,
    actorType: actor.phoneId ? "phone" : "user",
    actorId: actor.phoneId ?? actor.userId ?? null,
    action,
    entity: "movement",
    entityId: before.id,
    before,
    after,
    channel: actor.phoneId ? "whatsapp" : "dashboard",
  });
}

/** Aplica un `edit_last` confirmado. Devuelve null si el movimiento ya no existe o fue borrado. */
export async function amendMovement(
  tx: Tx,
  input: { tenantId: string; draft: EditLastDraft; actor: Actor; now: Date },
): Promise<Movement | null> {
  const [before] = await tx
    .select()
    .from(schema.movement)
    .where(and(eq(schema.movement.id, input.draft.movementId), isNull(schema.movement.deletedAt)));
  if (!before) return null;
  const a = input.draft.after;
  const [after] = await tx
    .update(schema.movement)
    .set({
      amount: a.amount,
      currency: a.currency,
      amountUsd: a.amountUsd,
      amountVes: a.amountVes,
      rateId: a.rateId,
      rateValue: a.rateValue,
      rateSource: a.rateSource,
      businessDate: a.businessDate,
      categoryId: a.categoryId,
      description: a.description,
      paymentMethod: a.paymentMethod,
      updatedAt: input.now,
    })
    .where(eq(schema.movement.id, before.id))
    .returning();
  if (!after) return null;
  await audit(tx, input.tenantId, input.actor, "update", before, after);
  return after;
}

export async function deleteMovement(
  tx: Tx,
  input: { tenantId: string; movementId: string; actor: Actor; now: Date },
): Promise<Movement | null> {
  const [before] = await tx
    .select()
    .from(schema.movement)
    .where(and(eq(schema.movement.id, input.movementId), isNull(schema.movement.deletedAt)));
  if (!before) return null;
  const [after] = await tx
    .update(schema.movement)
    .set({ deletedAt: input.now, updatedAt: input.now })
    .where(eq(schema.movement.id, before.id))
    .returning();
  if (!after) return null;
  await audit(tx, input.tenantId, input.actor, "delete", before, after);
  return after;
}
