import { and, asc, desc, eq, gt, isNull, schema, type Tx } from "@caja/db";
import { z } from "zod";
import type { IsoDate } from "../domain/dates";
import { Decimal, rate as makeRate, type Rate } from "../domain/money";
import type { Actor } from "./expenses";
import { NoRateError, rateFor } from "./rate-for";

/**
 * Lotes de cambio (0012, 04/10/2026). Quien cobra en USDT y los cambia a bolívares registra cada
 * cambio; los gastos en Bs salen del lote más viejo con saldo (FIFO) y su equivalente en dólares
 * sale a la tasa de ese lote. Un gasto que toma de dos lotes queda a la tasa ponderada, así el
 * total en dólares cuadra con lo que de verdad costaron esos bolívares. Si los lotes no alcanzan,
 * lo que falta va a la tasa del último cambio y se avisa.
 */
export type BsRateMode = "bcv" | "usdt" | "ask";

/** Payload del borrador `create_exchange`: un cambio por confirmar. */
export const ExchangeDraft = z.object({
  usd: z.string(),
  ves: z.string(),
  rate: z.string(),
  businessDate: z.string(),
  /** Cuentas (0013): a cuál entraron los Bs y de cuál salieron los USDT. */
  accountId: z.string().uuid().nullable().optional(),
  accountName: z.string().nullable().optional(),
  fromAccountId: z.string().uuid().nullable().optional(),
  fromAccountName: z.string().nullable().optional(),
});
export type ExchangeDraft = z.infer<typeof ExchangeDraft>;

export type LotSource = (typeof schema.LOT_SOURCES)[number];

export type LotPart = {
  lotId: string;
  ves: Decimal;
  rate: Decimal;
  /** De dónde vinieron esos Bs (un cambio, una venta, el saldo inicial) y de qué día. */
  source?: LotSource;
  businessDate?: string;
};

/**
 * Qué lotes mira un gasto: los de su cuenta (0013) o, sin cuenta, los de antes de las cuentas.
 */
function lotScope(accountId: string | null | undefined) {
  const l = schema.exchangeLot;
  return accountId ? eq(l.accountId, accountId) : isNull(l.accountId);
}

export type AllocationPlan = {
  parts: LotPart[];
  ves: Decimal;
  usd: Decimal;
  /** Tasa efectiva del gasto (Bs por dólar), 8 decimales. */
  rate: Decimal;
  /** Bs que no cubrió ningún lote (van a la tasa del último cambio). */
  uncoveredVes: Decimal;
  /** Tasa del último cambio registrado. */
  lastRate: Decimal;
  /** Saldo de todos los lotes después de este gasto. */
  remainingAfter: Decimal;
};

const D0 = new Decimal(0);

/** Desde este saldo (Bs) los lotes se consideran agotados: los céntimos sueltos no cuentan. */
export const LOT_DUST = new Decimal("0.01");

/**
 * De qué lotes saldrían `ves` bolívares. Con `lock`, bloquea los lotes (FOR UPDATE) para guardar
 * enseguida con `saveAllocation`. `adjust` suma o resta saldo por lote antes de calcular: lo que
 * un gasto que se está corrigiendo devolvería, o lo que ya tomaron los renglones anteriores de un
 * mismo borrador. Sin ningún lote registrado devuelve null (el gasto va a la BCV).
 */
export async function planAllocation(
  tx: Tx,
  tenantId: string,
  ves: Decimal,
  opts: { lock?: boolean; adjust?: Map<string, Decimal>; accountId?: string | null } = {},
): Promise<AllocationPlan | null> {
  const l = schema.exchangeLot;
  const base = tx
    .select({
      id: l.id,
      rate: l.rate,
      remaining: l.vesRemaining,
      source: l.source,
      businessDate: l.businessDate,
    })
    .from(l)
    .where(and(eq(l.tenantId, tenantId), isNull(l.deletedAt), lotScope(opts.accountId)))
    .orderBy(asc(l.businessDate), asc(l.createdAt), asc(l.id));
  const lots = opts.lock ? await base.for("update") : await base;
  if (lots.length === 0) return null;
  const last = await lastLotRate(tx, tenantId, opts.accountId);
  const lastRate = last ?? new Decimal(lots[lots.length - 1]?.rate ?? 1);

  let need = ves;
  let usd = D0;
  let available = D0;
  const parts: LotPart[] = [];
  for (const lot of lots) {
    const rate = new Decimal(lot.rate);
    const avail = Decimal.max(D0, new Decimal(lot.remaining).plus(opts.adjust?.get(lot.id) ?? 0));
    available = available.plus(avail);
    if (need.lte(0) || avail.lt(LOT_DUST)) continue;
    const take = Decimal.min(avail, need);
    parts.push({
      lotId: lot.id,
      ves: take,
      rate,
      source: lot.source as LotSource,
      businessDate: lot.businessDate,
    });
    usd = usd.plus(take.div(rate));
    need = need.minus(take);
  }
  const uncoveredVes = Decimal.max(D0, need);
  if (uncoveredVes.gt(0)) usd = usd.plus(uncoveredVes.div(lastRate));
  return {
    parts,
    ves,
    usd,
    rate: ves.div(usd).toDecimalPlaces(8, Decimal.ROUND_HALF_UP),
    uncoveredVes,
    lastRate,
    remainingAfter: Decimal.max(D0, available.minus(ves.minus(uncoveredVes))),
  };
}

/**
 * Un gasto en Bs toma de los lotes si su tasa es la de los lotes, o si es de una cuenta (0013):
 * aunque vaya a la BCV, sus Bs salen de la cuenta y los lotes quedan al día por si el negocio
 * cambia de modo.
 */
export function takesFromLots(
  type: string,
  currency: string,
  rateSource: string,
  accountId: string | null | undefined,
): boolean {
  return type === "expense" && currency === "VES" && (rateSource === "exchange" || !!accountId);
}

/** La tasa del plan como `Rate` de origen `exchange` para convertir y guardar el gasto. */
export function planRate(plan: AllocationPlan, businessDate: IsoDate | string): Rate {
  return makeRate(plan.rate, businessDate, null, "exchange");
}

async function lastLotRate(
  tx: Tx,
  tenantId: string,
  accountId: string | null | undefined,
): Promise<Decimal | null> {
  const l = schema.exchangeLot;
  const [row] = await tx
    .select({ rate: l.rate })
    .from(l)
    .where(and(eq(l.tenantId, tenantId), isNull(l.deletedAt), lotScope(accountId)))
    .orderBy(desc(l.businessDate), desc(l.createdAt))
    .limit(1);
  return row ? new Decimal(row.rate) : null;
}

/** De quién es una asignación de lotes: un gasto o (0014) una transferencia. */
export type AllocationOwner = { movementId: string } | { transferId: string };

function ownerWhere(tenantId: string, owner: AllocationOwner) {
  const a = schema.exchangeAllocation;
  return and(
    eq(a.tenantId, tenantId),
    "movementId" in owner ? eq(a.movementId, owner.movementId) : eq(a.transferId, owner.transferId),
  );
}

/** Descuenta los Bs de cada lote y deja constancia de qué lote pagó el gasto. */
export async function saveAllocation(
  tx: Tx,
  tenantId: string,
  movementId: string,
  parts: LotPart[],
): Promise<void> {
  await saveParts(tx, tenantId, { movementId }, parts);
}

export async function saveParts(
  tx: Tx,
  tenantId: string,
  owner: AllocationOwner,
  parts: LotPart[],
): Promise<void> {
  const l = schema.exchangeLot;
  for (const p of parts) {
    const ves = p.ves.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (ves.lte(0)) continue;
    const [lot] = await tx
      .select({ remaining: l.vesRemaining })
      .from(l)
      .where(and(eq(l.id, p.lotId), eq(l.tenantId, tenantId)));
    if (!lot) throw new Error("lote de cambio no encontrado");
    const left = Decimal.max(D0, new Decimal(lot.remaining).minus(ves));
    await tx
      .update(l)
      .set({ vesRemaining: left.toFixed(2), updatedAt: new Date() })
      .where(eq(l.id, p.lotId));
    await tx.insert(schema.exchangeAllocation).values({
      tenantId,
      movementId: "movementId" in owner ? owner.movementId : null,
      transferId: "transferId" in owner ? owner.transferId : null,
      lotId: p.lotId,
      vesAmount: ves.toFixed(2),
    });
  }
}

/** Devuelve a sus lotes los Bs de un gasto (al borrarlo o antes de recalcularlo). */
export async function releaseAllocation(
  tx: Tx,
  tenantId: string,
  movementId: string,
): Promise<Map<string, Decimal>> {
  return releaseParts(tx, tenantId, { movementId });
}

export async function releaseParts(
  tx: Tx,
  tenantId: string,
  owner: AllocationOwner,
): Promise<Map<string, Decimal>> {
  const a = schema.exchangeAllocation;
  const l = schema.exchangeLot;
  const rows = await tx
    .select({ id: a.id, lotId: a.lotId, ves: a.vesAmount })
    .from(a)
    .where(ownerWhere(tenantId, owner));
  const back = new Map<string, Decimal>();
  for (const r of rows) back.set(r.lotId, (back.get(r.lotId) ?? D0).plus(r.ves));
  for (const [lotId, ves] of back) {
    const [lot] = await tx
      .select({ remaining: l.vesRemaining, total: l.vesAmount })
      .from(l)
      .where(eq(l.id, lotId));
    if (!lot) continue;
    const restored = Decimal.min(new Decimal(lot.total), new Decimal(lot.remaining).plus(ves));
    await tx
      .update(l)
      .set({ vesRemaining: restored.toFixed(2), updatedAt: new Date() })
      .where(eq(l.id, lotId));
  }
  if (rows.length) await tx.delete(a).where(ownerWhere(tenantId, owner));
  return back;
}

/** Lo que un gasto tomó de cada lote, sin tocar nada (para recalcular una corrección). */
export async function allocationOf(
  tx: Tx,
  tenantId: string,
  movementId: string,
): Promise<Map<string, Decimal>> {
  const a = schema.exchangeAllocation;
  const rows = await tx
    .select({ lotId: a.lotId, ves: a.vesAmount })
    .from(a)
    .where(and(eq(a.tenantId, tenantId), eq(a.movementId, movementId)));
  const m = new Map<string, Decimal>();
  for (const r of rows) m.set(r.lotId, (m.get(r.lotId) ?? D0).plus(r.ves));
  return m;
}

export type ExchangeLotView = {
  id: string;
  accountId: string | null;
  fromAccountId: string | null;
  source: LotSource;
  businessDate: string;
  usdAmount: Decimal;
  vesAmount: Decimal;
  rate: Decimal;
  vesRemaining: Decimal;
  used: boolean;
};

/**
 * Lotes vivos del negocio, el más viejo primero; `active` solo los que tienen saldo, `source` solo
 * los de un origen (la lista de cambios muestra solo los cambios).
 */
export async function exchangeLots(
  tx: Tx,
  tenantId: string,
  opts: { active?: boolean; source?: LotSource } = {},
): Promise<ExchangeLotView[]> {
  const l = schema.exchangeLot;
  const rows = await tx
    .select()
    .from(l)
    .where(
      and(
        eq(l.tenantId, tenantId),
        isNull(l.deletedAt),
        opts.active ? gt(l.vesRemaining, LOT_DUST.toFixed(2)) : undefined,
        opts.source ? eq(l.source, opts.source) : undefined,
      ),
    )
    .orderBy(asc(l.businessDate), asc(l.createdAt));
  return rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    fromAccountId: r.fromAccountId,
    source: r.source as LotSource,
    businessDate: r.businessDate,
    usdAmount: new Decimal(r.usdAmount),
    vesAmount: new Decimal(r.vesAmount),
    rate: new Decimal(r.rate),
    vesRemaining: new Decimal(r.vesRemaining),
    used: new Decimal(r.vesRemaining).lt(new Decimal(r.vesAmount)),
  }));
}

/** Bs que quedan en los lotes de una cuenta (o en los de antes de las cuentas, sin cuenta). */
export async function lotBalance(
  tx: Tx,
  tenantId: string,
  accountId: string | null | undefined,
): Promise<Decimal> {
  const l = schema.exchangeLot;
  const found = await tx
    .select({ remaining: l.vesRemaining })
    .from(l)
    .where(and(eq(l.tenantId, tenantId), isNull(l.deletedAt), lotScope(accountId)));
  return found.reduce((s, r) => s.plus(r.remaining), D0);
}

export class ExchangeError extends Error {
  constructor(readonly code: "invalid" | "in_use" | "missing") {
    super(code);
    this.name = "ExchangeError";
  }
}

/**
 * Completa un cambio con dos de sus tres datos: dólares, bolívares y tasa. "100 usdt a 970" →
 * Bs 97.000; "100 usdt, me dieron 97.000" → tasa 970. Null si no alcanza o no es positivo.
 */
export function completeExchange(input: {
  usd: Decimal | null;
  ves: Decimal | null;
  rate: Decimal | null;
}): { usd: Decimal; ves: Decimal; rate: Decimal } | null {
  const { usd, ves, rate } = input;
  const pos = (d: Decimal | null): d is Decimal => !!d && d.isFinite() && d.gt(0);
  const r2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const r8 = (d: Decimal) => d.toDecimalPlaces(8, Decimal.ROUND_HALF_UP);
  if (pos(usd) && pos(ves)) return { usd: r2(usd), ves: r2(ves), rate: r8(ves.div(usd)) };
  if (pos(usd) && pos(rate)) return { usd: r2(usd), ves: r2(usd.mul(rate)), rate: r8(rate) };
  if (pos(ves) && pos(rate)) return { usd: r2(ves.div(rate)), ves: r2(ves), rate: r8(rate) };
  return null;
}

/**
 * Un cambio a menos de la mitad o a más del triple de la BCV es un error de tipeo (970 escrito 97,
 * o los Bs con el punto de miles leído como decimal). Devuelve la BCV si no pasa; null si pasa o
 * si no hay BCV para comparar.
 */
export async function implausibleExchangeRate(
  tx: Tx,
  rate: Decimal,
  businessDate: IsoDate,
): Promise<Decimal | null> {
  try {
    const { rate: bcv } = await rateFor(tx, businessDate);
    return rate.lt(bcv.value.div(2)) || rate.gt(bcv.value.mul(3)) ? bcv.value : null;
  } catch (err) {
    if (err instanceof NoRateError) return null;
    throw err;
  }
}

export async function createExchangeLot(
  tx: Tx,
  input: {
    tenantId: string;
    businessDate: IsoDate | string;
    usd: Decimal;
    ves: Decimal;
    rate: Decimal;
    actor: Actor;
    channel: "whatsapp" | "dashboard";
    /** Cuenta en Bs que recibió los bolívares (0013). */
    accountId?: string | null;
    /** Cuenta en dólares de donde salieron los USDT. */
    fromAccountId?: string | null;
  },
): Promise<string> {
  if (!(input.usd.gt(0) && input.ves.gt(0) && input.rate.gt(0))) throw new ExchangeError("invalid");
  const [row] = await tx
    .insert(schema.exchangeLot)
    .values({
      tenantId: input.tenantId,
      businessDate: input.businessDate,
      usdAmount: input.usd.toFixed(2),
      vesAmount: input.ves.toFixed(2),
      rate: input.rate.toFixed(8),
      vesRemaining: input.ves.toFixed(2),
      accountId: input.accountId ?? null,
      fromAccountId: input.fromAccountId ?? null,
      source: "exchange",
      createdByPhoneId: input.actor.phoneId ?? null,
      createdByUserId: input.actor.userId ?? null,
    })
    .returning();
  if (!row) throw new Error("no se pudo guardar el cambio");
  await audit(tx, input.tenantId, input.actor, input.channel, "create", row.id, null, row);
  return row.id;
}

/** Borra un cambio que ningún gasto usó. Uno usado se corrige borrando o editando sus gastos. */
export async function deleteExchangeLot(
  tx: Tx,
  input: { tenantId: string; lotId: string; actor: Actor; now: Date },
): Promise<void> {
  const l = schema.exchangeLot;
  const [lot] = await tx
    .select()
    .from(l)
    .where(
      and(
        eq(l.id, input.lotId),
        eq(l.tenantId, input.tenantId),
        eq(l.source, "exchange"),
        isNull(l.deletedAt),
      ),
    )
    .for("update");
  if (!lot) throw new ExchangeError("missing");
  const [used] = await tx
    .select({ id: schema.exchangeAllocation.id })
    .from(schema.exchangeAllocation)
    .where(eq(schema.exchangeAllocation.lotId, input.lotId))
    .limit(1);
  if (used) throw new ExchangeError("in_use");
  await tx.update(l).set({ deletedAt: input.now, updatedAt: input.now }).where(eq(l.id, lot.id));
  await audit(tx, input.tenantId, input.actor, "dashboard", "delete", lot.id, lot, null);
}

export async function getBsRateMode(tx: Tx, tenantId: string): Promise<BsRateMode> {
  const [t] = await tx
    .select({ mode: schema.tenant.bsRateMode })
    .from(schema.tenant)
    .where(eq(schema.tenant.id, tenantId));
  return (t?.mode as BsRateMode | undefined) ?? "bcv";
}

export async function setBsRateMode(
  tx: Tx,
  input: { tenantId: string; mode: BsRateMode; actor: Actor; channel: "whatsapp" | "dashboard" },
): Promise<void> {
  const before = await getBsRateMode(tx, input.tenantId);
  if (before === input.mode) return;
  await tx
    .update(schema.tenant)
    .set({ bsRateMode: input.mode, updatedAt: new Date() })
    .where(eq(schema.tenant.id, input.tenantId));
  await tx.insert(schema.auditLog).values({
    tenantId: input.tenantId,
    actorType: input.actor.phoneId ? "phone" : "user",
    actorId: input.actor.phoneId ?? input.actor.userId ?? null,
    action: "update",
    entity: "tenant",
    entityId: input.tenantId,
    before: { bsRateMode: before },
    after: { bsRateMode: input.mode },
    channel: input.channel,
  });
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
    entity: "exchange_lot",
    entityId,
    before,
    after,
    channel,
  });
}
