import { and, eq, isNull, schema, type Tx } from "@caja/db";
import { z } from "zod";
import type { IsoDate } from "../domain/dates";
import { type Currency, Decimal } from "../domain/money";
import type { AccountKind } from "./accounts";
import { planAllocation, releaseParts, saveAllocation, saveParts } from "./exchange";
import { type Actor, createExpense } from "./expenses";
import { deleteMovement } from "./last-movement";
import { NoRateError, rateFor } from "./rate-for";

/**
 * Transferencias entre cuentas (0014, fase 2 de cuentas). Pasar dinero de una cuenta a otra no es
 * gasto ni venta: solo cambia dónde está. Dos casos:
 * - misma moneda ("pasé 100$ de Zelle a Binance", "del BDV a Banesco"): sale y entra lo mismo;
 * - bolívares → dólares (comprar USDT con Bs): sale en Bs, entra en USDT.
 * Dólares → bolívares es un cambio (exchange_lot), no una transferencia.
 * Entre cuentas en Bs los bolívares se llevan su costo: salen de los lotes de la cuenta de origen
 * y entran como un lote de la de destino a esa misma tasa. La comisión es un gasto aparte de la
 * cuenta de origen, para que cuente en los gastos del negocio.
 */
const AccountSide = z.object({
  id: z.string().uuid(),
  name: z.string(),
  currency: z.enum(["USD", "VES"]),
  kind: z.string(),
});

/** Payload del borrador `create_transfer`. */
export const TransferDraft = z.object({
  from: AccountSide,
  to: AccountSide,
  fromAmount: z.string(),
  toAmount: z.string(),
  /** Comisión en la moneda de la cuenta de origen; null si no hubo. */
  fee: z.string().nullable(),
  businessDate: z.string(),
  description: z.string().nullable(),
});
export type TransferDraft = z.infer<typeof TransferDraft>;

export class TransferError extends Error {
  constructor(readonly code: "invalid" | "same_account" | "use_exchange" | "missing" | "in_use") {
    super(code);
    this.name = "TransferError";
  }
}

type Side = { id: string; name: string; currency: Currency; kind: AccountKind | string };

/**
 * Completa los montos según las monedas: misma moneda → sale y entra lo mismo; Bs → USDT necesita
 * dos de tres datos (Bs, USDT, tasa). Null si no alcanza. "use_exchange" si es dólares → Bs.
 */
export function transferAmounts(
  from: Pick<Side, "currency">,
  to: Pick<Side, "currency">,
  input: { fromAmount: Decimal | null; toAmount: Decimal | null; rate: Decimal | null },
): { fromAmount: Decimal; toAmount: Decimal } | null | "use_exchange" {
  const pos = (d: Decimal | null): d is Decimal => !!d && d.isFinite() && d.gt(0);
  const r2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (from.currency === "USD" && to.currency === "VES") return "use_exchange";
  if (from.currency === to.currency) {
    // USDT → $ (o $ → USDT) por P2P (08/10): salen 87,70 USDT y llegan $90,00. Si dice los dos
    // montos y son distintos, se respetan; la diferencia queda en los saldos. Más del doble o
    // menos de la mitad no es una transferencia: se pregunta.
    const { fromAmount: sent, toAmount: got } = input;
    if (pos(sent) && pos(got) && !r2(sent).eq(r2(got))) {
      const ratio = got.div(sent);
      return ratio.gte(0.5) && ratio.lte(2) ? { fromAmount: r2(sent), toAmount: r2(got) } : null;
    }
    const amount = pos(sent) ? sent : got;
    return pos(amount) ? { fromAmount: r2(amount), toAmount: r2(amount) } : null;
  }
  // Bs → USDT.
  const { fromAmount: ves, toAmount: usd, rate } = input;
  if (pos(ves) && pos(usd)) return { fromAmount: r2(ves), toAmount: r2(usd) };
  if (pos(ves) && pos(rate)) return { fromAmount: r2(ves), toAmount: r2(ves.div(rate)) };
  if (pos(usd) && pos(rate)) return { fromAmount: r2(usd.mul(rate)), toAmount: r2(usd) };
  return null;
}

async function activeAccount(tx: Tx, tenantId: string, id: string) {
  const a = schema.account;
  const [row] = await tx
    .select()
    .from(a)
    .where(and(eq(a.id, id), eq(a.tenantId, tenantId), isNull(a.archivedAt)));
  return row ?? null;
}

/** Categoría para la comisión: una que se llame "comisión…" o "banco…"; si no, Otros. */
async function feeCategory(tx: Tx, tenantId: string): Promise<string | null> {
  const c = schema.category;
  const all = await tx
    .select({ id: c.id, name: c.name })
    .from(c)
    .where(and(eq(c.tenantId, tenantId), eq(c.kind, "expense"), eq(c.isActive, true)));
  const plain = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return (
    all.find((x) => /comisi/.test(plain(x.name)))?.id ??
    all.find((x) => /banc/.test(plain(x.name)))?.id ??
    all.find((x) => plain(x.name) === "otros")?.id ??
    null
  );
}

export type CreatedTransfer = { id: string; feeMovementId: string | null };

export async function createTransfer(
  tx: Tx,
  input: {
    tenantId: string;
    fromAccountId: string;
    toAccountId: string;
    fromAmount: Decimal;
    toAmount: Decimal;
    fee: Decimal | null;
    businessDate: IsoDate;
    description: string | null;
    actor: Actor;
    channel: "whatsapp" | "dashboard";
    sourceChannel?: "text" | "voice" | "image" | "dashboard";
  },
): Promise<CreatedTransfer> {
  if (input.fromAccountId === input.toAccountId) throw new TransferError("same_account");
  const from = await activeAccount(tx, input.tenantId, input.fromAccountId);
  const to = await activeAccount(tx, input.tenantId, input.toAccountId);
  if (!from || !to) throw new TransferError("missing");
  if (from.currency === "USD" && to.currency === "VES") throw new TransferError("use_exchange");
  const ok = (d: Decimal) => d.isFinite() && d.gt(0);
  if (!ok(input.fromAmount) || !ok(input.toAmount)) throw new TransferError("invalid");
  if (from.currency === to.currency && !input.fromAmount.eq(input.toAmount))
    throw new TransferError("invalid");
  if (input.fee && (!input.fee.isFinite() || input.fee.lt(0))) throw new TransferError("invalid");

  const [row] = await tx
    .insert(schema.accountTransfer)
    .values({
      tenantId: input.tenantId,
      fromAccountId: from.id,
      toAccountId: to.id,
      fromAmount: input.fromAmount.toFixed(2),
      toAmount: input.toAmount.toFixed(2),
      businessDate: input.businessDate,
      description: input.description,
      createdByPhoneId: input.actor.phoneId ?? null,
      createdByUserId: input.actor.userId ?? null,
    })
    .returning();
  if (!row) throw new Error("no se pudo guardar la transferencia");

  // Los Bs salen de los lotes de la cuenta de origen con su costo en dólares.
  if (from.currency === "VES") {
    const plan = await planAllocation(tx, input.tenantId, input.fromAmount, {
      lock: true,
      accountId: from.id,
    });
    if (plan) await saveParts(tx, input.tenantId, { transferId: row.id }, plan.parts);
    if (to.currency === "VES") {
      const rate = plan
        ? plan.rate
        : await rateFor(tx, input.businessDate)
            .then((r) => r.rate.value)
            .catch((err) => {
              if (err instanceof NoRateError) return null;
              throw err;
            });
      if (rate?.gt(0)) {
        const usd = Decimal.max(new Decimal("0.01"), input.toAmount.div(rate));
        await tx.insert(schema.exchangeLot).values({
          tenantId: input.tenantId,
          accountId: to.id,
          source: "transfer",
          transferId: row.id,
          businessDate: input.businessDate,
          usdAmount: usd.toFixed(2),
          vesAmount: input.toAmount.toFixed(2),
          rate: rate.toFixed(8),
          vesRemaining: input.toAmount.toFixed(2),
        });
      }
    }
  }

  let feeMovementId: string | null = null;
  if (input.fee?.gt(0)) {
    const currency = from.currency as Currency;
    const plan =
      currency === "VES"
        ? await planAllocation(tx, input.tenantId, input.fee, { lock: true, accountId: from.id })
        : null;
    const created = await createExpense(tx, {
      tenantId: input.tenantId,
      businessDate: input.businessDate,
      amount: input.fee,
      currency,
      categoryId: await feeCategory(tx, input.tenantId),
      description: `Comisión ${from.name} → ${to.name}`.slice(0, 120),
      sourceChannel: input.sourceChannel ?? (input.channel === "dashboard" ? "dashboard" : "text"),
      actor: input.actor,
      accountId: from.id,
    });
    if (plan) await saveAllocation(tx, input.tenantId, created.id, plan.parts);
    feeMovementId = created.id;
    await tx
      .update(schema.accountTransfer)
      .set({ feeMovementId })
      .where(eq(schema.accountTransfer.id, row.id));
  }
  await audit(tx, input.tenantId, input.actor, input.channel, "create", row.id, null, {
    ...row,
    feeMovementId,
  });
  return { id: row.id, feeMovementId };
}

/**
 * Borra una transferencia: los Bs vuelven a los lotes de la cuenta de origen, el lote que dejó en
 * la de destino se da de baja y la comisión se borra. Si un gasto ya tomó Bs de ese lote, no se
 * puede (como un cambio usado): primero hay que borrar o mover ese gasto.
 */
export async function deleteTransfer(
  tx: Tx,
  input: { tenantId: string; transferId: string; actor: Actor; now: Date },
): Promise<void> {
  const t = schema.accountTransfer;
  const [before] = await tx
    .select()
    .from(t)
    .where(and(eq(t.id, input.transferId), eq(t.tenantId, input.tenantId), isNull(t.deletedAt)))
    .for("update");
  if (!before) throw new TransferError("missing");
  const l = schema.exchangeLot;
  const [lot] = await tx
    .select()
    .from(l)
    .where(and(eq(l.transferId, before.id), isNull(l.deletedAt)))
    .for("update");
  if (lot) {
    const [used] = await tx
      .select({ id: schema.exchangeAllocation.id })
      .from(schema.exchangeAllocation)
      .where(eq(schema.exchangeAllocation.lotId, lot.id))
      .limit(1);
    if (used) throw new TransferError("in_use");
    await tx.update(l).set({ deletedAt: input.now, updatedAt: input.now }).where(eq(l.id, lot.id));
  }
  await releaseParts(tx, input.tenantId, { transferId: before.id });
  if (before.feeMovementId)
    await deleteMovement(tx, {
      tenantId: input.tenantId,
      movementId: before.feeMovementId,
      actor: input.actor,
      now: input.now,
    });
  const [after] = await tx
    .update(t)
    .set({ deletedAt: input.now, updatedAt: input.now })
    .where(eq(t.id, before.id))
    .returning();
  await audit(
    tx,
    input.tenantId,
    input.actor,
    input.actor.phoneId ? "whatsapp" : "dashboard",
    "delete",
    before.id,
    before,
    after,
  );
}

/** La tasa a la que salieron los Bs de una compra de USDT (para mostrarla). */
export function transferRate(fromAmount: Decimal.Value, toAmount: Decimal.Value): Decimal {
  return new Decimal(fromAmount).div(toAmount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

async function audit(
  tx: Tx,
  tenantId: string,
  actor: Actor,
  channel: "whatsapp" | "dashboard",
  action: "create" | "delete",
  entityId: string,
  before: unknown,
  after: unknown,
) {
  await tx.insert(schema.auditLog).values({
    tenantId,
    actorType: actor.phoneId ? "phone" : "user",
    actorId: actor.phoneId ?? actor.userId ?? null,
    action,
    entity: "account_transfer",
    entityId,
    before,
    after,
    channel,
  });
}
