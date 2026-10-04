import { and, asc, eq, isNull, rows, schema, sql, type Tx } from "@caja/db";
import type { IsoDate } from "../domain/dates";
import { type Currency, Decimal } from "../domain/money";
import { BANK_ALIAS_CODE } from "../domain/pago-movil";
import type { Actor } from "./expenses";
import type { PaymentMethod } from "./income";
import { NoRateError, rateFor } from "./rate-for";

/**
 * Cuentas (0013, 04/10/2026, como Rial). El dinero vive en cuentas: Banco de Venezuela en Bs,
 * Binance en USDT, Zelle, Efectivo. Cada gasto o venta puede decir de qué cuenta salió o a cuál
 * entró, y el saldo sale de la aritmética: saldo inicial + ventas − gastos + cambios recibidos −
 * cambios enviados. En una cuenta en Bs los lotes dicen cuánto costó en dólares cada bolívar
 * (un cambio, una venta o el saldo inicial a la BCV de ese día). Son opcionales: un negocio sin
 * cuentas sigue como antes.
 */
export type AccountKind = (typeof schema.ACCOUNT_KINDS)[number];

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  bank: "Banco",
  cash: "Efectivo",
  zelle: "Zelle",
  crypto: "Binance / USDT",
  other: "Otra",
};

export type AccountRef = { id: string; name: string; currency: Currency; kind: AccountKind };

export type AccountView = AccountRef & {
  openingBalance: Decimal;
  openingDate: string;
  sortOrder: number;
  /** Saldo en la moneda de la cuenta. */
  balance: Decimal;
};

export const MAX_ACCOUNTS = 12;

export class AccountError extends Error {
  constructor(readonly code: "invalid" | "duplicate" | "missing" | "too_many" | "in_use") {
    super(code);
    this.name = "AccountError";
  }
}

const D0 = new Decimal(0);

/** "USDT" para Binance, "$" o "Bs" para el resto: así lo dicen los usuarios. */
export function accountUnit(a: { currency: string; kind: string }): string {
  if (a.currency === "VES") return "Bs";
  return a.kind === "crypto" ? "USDT" : "$";
}

/** Cuentas activas, en el orden del dueño (la primera de cada moneda es la principal). */
export async function listAccounts(tx: Tx, tenantId: string): Promise<AccountRef[]> {
  const a = schema.account;
  const found = await tx
    .select({ id: a.id, name: a.name, currency: a.currency, kind: a.kind })
    .from(a)
    .where(and(eq(a.tenantId, tenantId), isNull(a.archivedAt)))
    .orderBy(asc(a.sortOrder), asc(a.createdAt));
  return found.map((r) => ({
    ...r,
    currency: r.currency as Currency,
    kind: r.kind as AccountKind,
  }));
}

/**
 * Saldo de cada cuenta activa, todo en SQL. Un movimiento en otra moneda que la cuenta cuenta por
 * su equivalente (un gasto en $ pagado con pago móvil resta sus Bs a la tasa del gasto). Los lotes
 * adoptados (de antes de las cuentas) ya están dentro del saldo inicial.
 */
export async function accountBalances(tx: Tx, tenantId: string): Promise<AccountView[]> {
  const found = rows<{
    id: string;
    name: string;
    currency: string;
    kind: string;
    opening_balance: string;
    opening_date: string;
    sort_order: number;
    balance: string;
  }>(
    await tx.execute(sql`
      select a.id, a.name, a.currency, a.kind, a.opening_balance::text, a.opening_date::text,
        a.sort_order,
        (a.opening_balance
          + coalesce((select sum(
                (case when m.type = 'income' then 1 else -1 end)
                * (case when m.currency = a.currency then m.amount
                        when a.currency = 'USD' then m.amount_usd
                        else m.amount_ves end))
              from ${schema.movement} m
              where m.account_id = a.id and m.deleted_at is null), 0)
          + coalesce((select sum(l.ves_amount) from ${schema.exchangeLot} l
              where l.account_id = a.id and l.source = 'exchange' and l.deleted_at is null
                and l.adopted_at is null), 0)
          - coalesce((select sum(l.usd_amount) from ${schema.exchangeLot} l
              where l.from_account_id = a.id and l.source = 'exchange'
                and l.deleted_at is null), 0)
        )::text as balance
      from ${schema.account} a
      where a.tenant_id = ${tenantId} and a.archived_at is null
      order by a.sort_order, a.created_at
    `),
  );
  return found.map((r) => ({
    id: r.id,
    name: r.name,
    currency: r.currency as Currency,
    kind: r.kind as AccountKind,
    openingBalance: new Decimal(r.opening_balance),
    openingDate: r.opening_date,
    sortOrder: Number(r.sort_order),
    balance: new Decimal(r.balance),
  }));
}

export async function accountBalance(
  tx: Tx,
  tenantId: string,
  accountId: string,
): Promise<AccountView | null> {
  return (await accountBalances(tx, tenantId)).find((a) => a.id === accountId) ?? null;
}

export type NetWorth = {
  usd: Decimal;
  ves: Decimal;
  /** Todo en dólares: los Bs a la BCV de hoy. Null sin tasa. */
  totalUsd: Decimal | null;
  rate: Decimal | null;
};

/** Patrimonio: lo que hay en dólares más los Bs a lo que valen hoy a la BCV. */
export function netWorth(accounts: AccountView[], bcvToday: Decimal | null): NetWorth {
  const usd = accounts.filter((a) => a.currency === "USD").reduce((s, a) => s.plus(a.balance), D0);
  const ves = accounts.filter((a) => a.currency === "VES").reduce((s, a) => s.plus(a.balance), D0);
  return {
    usd,
    ves,
    totalUsd: bcvToday?.gt(0) ? usd.plus(ves.div(bcvToday)) : ves.isZero() ? usd : null,
    rate: bcvToday,
  };
}

const plain = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 40);
}

/**
 * Crea una cuenta. En Bs, el saldo inicial queda como lote a la BCV del día de apertura. La
 * primera cuenta en Bs adopta los cambios de antes de las cuentas: sus Bs restantes son parte del
 * saldo inicial, y solo el resto va a la BCV.
 */
export async function createAccount(
  tx: Tx,
  input: {
    tenantId: string;
    name: string;
    currency: Currency;
    kind: AccountKind;
    openingBalance: Decimal;
    openingDate: IsoDate;
    actor: Actor;
    channel: "whatsapp" | "dashboard";
  },
): Promise<AccountRef> {
  const name = cleanName(input.name);
  if (!name || !input.openingBalance.isFinite()) throw new AccountError("invalid");
  if (!schema.ACCOUNT_KINDS.includes(input.kind)) throw new AccountError("invalid");
  const existing = await listAccounts(tx, input.tenantId);
  if (existing.length >= MAX_ACCOUNTS) throw new AccountError("too_many");
  if (existing.some((a) => plain(a.name) === plain(name))) throw new AccountError("duplicate");
  const a = schema.account;
  const [maxRow] = rows<{ max: number | null }>(
    await tx.execute(
      sql`select max(sort_order) as max from ${a} where tenant_id = ${input.tenantId}`,
    ),
  );
  const [row] = await tx
    .insert(a)
    .values({
      tenantId: input.tenantId,
      name,
      currency: input.currency,
      kind: input.kind,
      openingBalance: input.openingBalance.toFixed(2),
      openingDate: input.openingDate,
      sortOrder: (maxRow?.max ?? -1) + 1,
      createdByPhoneId: input.actor.phoneId ?? null,
      createdByUserId: input.actor.userId ?? null,
    })
    .returning();
  if (!row) throw new Error("no se pudo crear la cuenta");
  await audit(tx, input.tenantId, input.actor, input.channel, "create", row.id, null, row);
  if (input.currency === "VES") {
    const adopted = await adoptLegacyLots(tx, input.tenantId, row.id, input.openingBalance);
    const rest = input.openingBalance.minus(adopted);
    if (rest.gt(0)) await adjustOpeningLot(tx, input.tenantId, row.id, input.openingDate, rest);
  }
  return { id: row.id, name: row.name, currency: input.currency, kind: input.kind };
}

/**
 * Pasa a la cuenta los lotes sin cuenta con saldo. Si el saldo inicial es menor que lo que queda
 * de esos cambios, se descuenta de los más viejos (se gastaron sin anotar). Devuelve los Bs
 * adoptados.
 */
async function adoptLegacyLots(
  tx: Tx,
  tenantId: string,
  accountId: string,
  opening: Decimal,
): Promise<Decimal> {
  const l = schema.exchangeLot;
  const legacy = await tx
    .select({ id: l.id, remaining: l.vesRemaining })
    .from(l)
    .where(and(eq(l.tenantId, tenantId), isNull(l.accountId), isNull(l.deletedAt)))
    .orderBy(asc(l.businessDate), asc(l.createdAt), asc(l.id))
    .for("update");
  if (!legacy.length) return D0;
  const total = legacy.reduce((s, r) => s.plus(r.remaining), D0);
  let trim = Decimal.max(D0, total.minus(Decimal.max(D0, opening)));
  const now = new Date();
  for (const lot of legacy) {
    const remaining = new Decimal(lot.remaining);
    const cut = Decimal.min(remaining, trim);
    trim = trim.minus(cut);
    await tx
      .update(l)
      .set({
        accountId,
        adoptedAt: now,
        vesRemaining: remaining.minus(cut).toFixed(2),
        updatedAt: now,
      })
      .where(eq(l.id, lot.id));
  }
  return Decimal.min(total, Decimal.max(D0, opening));
}

/**
 * Suma `delta` Bs al lote del saldo inicial (lo crea a la BCV de la fecha de apertura si no
 * existe; si queda en cero, lo da de baja). Sin BCV para esa fecha no hay lote: esos Bs van a la
 * BCV del día de cada gasto.
 */
async function adjustOpeningLot(
  tx: Tx,
  tenantId: string,
  accountId: string,
  openingDate: IsoDate,
  delta: Decimal,
): Promise<void> {
  if (delta.isZero()) return;
  const l = schema.exchangeLot;
  const now = new Date();
  const [lot] = await tx
    .select()
    .from(l)
    .where(and(eq(l.accountId, accountId), eq(l.source, "opening"), isNull(l.deletedAt)))
    .for("update");
  if (lot) {
    const ves = new Decimal(lot.vesAmount).plus(delta);
    if (ves.lte(LOT_MIN)) {
      await tx.update(l).set({ deletedAt: now, updatedAt: now }).where(eq(l.id, lot.id));
      return;
    }
    const rate = new Decimal(lot.rate);
    const remaining = Decimal.min(ves, Decimal.max(D0, new Decimal(lot.vesRemaining).plus(delta)));
    await tx
      .update(l)
      .set({
        vesAmount: ves.toFixed(2),
        usdAmount: Decimal.max(new Decimal("0.01"), ves.div(rate)).toFixed(2),
        vesRemaining: remaining.toFixed(2),
        updatedAt: now,
      })
      .where(eq(l.id, lot.id));
    return;
  }
  if (delta.lte(LOT_MIN)) return;
  const bcv = await bcvOrNull(tx, openingDate);
  if (!bcv) return;
  await tx.insert(l).values({
    tenantId,
    accountId,
    source: "opening",
    businessDate: openingDate,
    usdAmount: Decimal.max(new Decimal("0.01"), delta.div(bcv)).toFixed(2),
    vesAmount: delta.toFixed(2),
    rate: bcv.toFixed(8),
    vesRemaining: delta.toFixed(2),
  });
}

/** Un lote necesita más de un céntimo de dólar: con menos no hay tasa que sirva. */
const LOT_MIN = new Decimal("0.01");

async function bcvOrNull(tx: Tx, date: IsoDate): Promise<Decimal | null> {
  try {
    return (await rateFor(tx, date)).rate.value;
  } catch (err) {
    if (err instanceof NoRateError) return null;
    throw err;
  }
}

export async function updateAccount(
  tx: Tx,
  input: {
    tenantId: string;
    accountId: string;
    name?: string;
    kind?: AccountKind;
    openingBalance?: Decimal;
    actor: Actor;
  },
): Promise<void> {
  const a = schema.account;
  const [before] = await tx
    .select()
    .from(a)
    .where(and(eq(a.id, input.accountId), eq(a.tenantId, input.tenantId), isNull(a.archivedAt)))
    .for("update");
  if (!before) throw new AccountError("missing");
  const name = input.name !== undefined ? cleanName(input.name) : before.name;
  if (!name) throw new AccountError("invalid");
  if (input.kind && !schema.ACCOUNT_KINDS.includes(input.kind)) throw new AccountError("invalid");
  if (input.openingBalance && !input.openingBalance.isFinite()) throw new AccountError("invalid");
  if (plain(name) !== plain(before.name)) {
    const others = await listAccounts(tx, input.tenantId);
    if (others.some((o) => o.id !== before.id && plain(o.name) === plain(name)))
      throw new AccountError("duplicate");
  }
  const opening = input.openingBalance ?? new Decimal(before.openingBalance);
  const [after] = await tx
    .update(a)
    .set({
      name,
      kind: input.kind ?? before.kind,
      openingBalance: opening.toFixed(2),
      updatedAt: new Date(),
    })
    .where(eq(a.id, before.id))
    .returning();
  if (before.currency === "VES")
    await adjustOpeningLot(
      tx,
      input.tenantId,
      before.id,
      before.openingDate as IsoDate,
      opening.minus(before.openingBalance),
    );
  await audit(tx, input.tenantId, input.actor, "dashboard", "update", before.id, before, after);
}

/**
 * Archiva una cuenta: deja de ofrecerse y de contar en el patrimonio. Sus movimientos quedan
 * como están. Se puede volver a crear otra con el mismo nombre.
 */
export async function archiveAccount(
  tx: Tx,
  input: { tenantId: string; accountId: string; actor: Actor; now: Date },
): Promise<void> {
  const a = schema.account;
  const [before] = await tx
    .select()
    .from(a)
    .where(and(eq(a.id, input.accountId), eq(a.tenantId, input.tenantId), isNull(a.archivedAt)))
    .for("update");
  if (!before) throw new AccountError("missing");
  const [after] = await tx
    .update(a)
    .set({ archivedAt: input.now, updatedAt: input.now })
    .where(eq(a.id, before.id))
    .returning();
  await audit(tx, input.tenantId, input.actor, "dashboard", "delete", before.id, before, after);
}

/**
 * Deja el lote de una venta en Bs igual a la venta: lo crea, lo ajusta o lo da de baja. Lo que
 * los gastos ya tomaron de él se respeta. Se llama después de crear, corregir o borrar un ingreso.
 */
export async function syncIncomeLot(tx: Tx, tenantId: string, movementId: string): Promise<void> {
  const m = schema.movement;
  const l = schema.exchangeLot;
  const [mv] = await tx
    .select({
      type: m.type,
      currency: m.currency,
      amount: m.amount,
      amountUsd: m.amountUsd,
      businessDate: m.businessDate,
      accountId: m.accountId,
      deletedAt: m.deletedAt,
      accountCurrency: schema.account.currency,
    })
    .from(m)
    .leftJoin(schema.account, eq(schema.account.id, m.accountId))
    .where(and(eq(m.id, movementId), eq(m.tenantId, tenantId)));
  const [lot] = await tx
    .select()
    .from(l)
    .where(and(eq(l.movementId, movementId), isNull(l.deletedAt)))
    .for("update");
  const now = new Date();
  const wanted =
    mv &&
    !mv.deletedAt &&
    mv.type === "income" &&
    mv.currency === "VES" &&
    mv.accountId &&
    mv.accountCurrency === "VES" &&
    new Decimal(mv.amountUsd).gt(0);
  if (!wanted) {
    if (lot) await tx.update(l).set({ deletedAt: now, updatedAt: now }).where(eq(l.id, lot.id));
    return;
  }
  const ves = new Decimal(mv.amount);
  const usd = new Decimal(mv.amountUsd);
  const rate = ves.div(usd).toDecimalPlaces(8, Decimal.ROUND_HALF_UP);
  if (!lot) {
    await tx.insert(l).values({
      tenantId,
      accountId: mv.accountId,
      source: "income",
      movementId,
      businessDate: mv.businessDate,
      usdAmount: usd.toFixed(2),
      vesAmount: ves.toFixed(2),
      rate: rate.toFixed(8),
      vesRemaining: ves.toFixed(2),
    });
    return;
  }
  const used = new Decimal(lot.vesAmount).minus(lot.vesRemaining);
  await tx
    .update(l)
    .set({
      accountId: mv.accountId,
      businessDate: mv.businessDate,
      usdAmount: usd.toFixed(2),
      vesAmount: ves.toFixed(2),
      rate: rate.toFixed(8),
      vesRemaining: Decimal.max(D0, ves.minus(used)).toFixed(2),
      updatedAt: now,
    })
    .where(eq(l.id, lot.id));
}

// ---------------------------------------------------------------- a qué cuenta va

/** Método de pago → tipo de cuenta que lo recibe. */
const METHOD_KIND: Partial<Record<PaymentMethod, { kind: AccountKind; currency: Currency }>> = {
  cash_usd: { kind: "cash", currency: "USD" },
  cash_ves: { kind: "cash", currency: "VES" },
  pago_movil: { kind: "bank", currency: "VES" },
  punto: { kind: "bank", currency: "VES" },
  transfer_ves: { kind: "bank", currency: "VES" },
  zelle: { kind: "zelle", currency: "USD" },
  transfer_usd: { kind: "bank", currency: "USD" },
};

/** Palabras del mensaje que dicen el tipo de cuenta ("con pago móvil", "en efectivo", "por binance"). */
const KIND_WORDS: [RegExp, AccountKind][] = [
  [/\b(pago ?movil|punto|transferencia|transferi|debito|tarjeta)\b/, "bank"],
  [/\b(efectivo|cash|billete|billetes|fisico)\b/, "cash"],
  [/\bzelle\b/, "zelle"],
  [/\b(binance|usdt|cripto|crypto|tether|p2p)\b/, "crypto"],
];

/**
 * La cuenta de un movimiento, sin preguntar: (1) una cuenta de esa moneda nombrada en el mensaje
 * ("de Banesco", "con el BDV"); (2) el método de pago o las palabras del mensaje (pago móvil →
 * banco, efectivo, Zelle, Binance); (3) una cuenta de otra moneda nombrada ("pagué 10$ con
 * Banesco"); (4) la principal de esa moneda (la primera en el orden del dueño). El borrador muestra
 * la cuenta y el usuario la corrige si no es. Null si no hay cuentas en esa moneda ni una nombrada.
 */
export function resolveAccount(
  accounts: AccountRef[],
  input: {
    currency: Currency;
    /** Texto del usuario en este turno; se busca primero aquí. */
    text: string;
    /** Turnos anteriores (una corrección "fue de Banesco" no repite el monto). */
    context?: string;
    method?: PaymentMethod | null;
    preferKind?: AccountKind;
    /** Solo cuentas de esa moneda, aunque nombre otra (un cambio: "de Binance al Banesco"). */
    strictCurrency?: boolean;
    /** Sin la principal al final: null si el texto no dice nada (para probar un renglón primero). */
    noFallback?: boolean;
  },
): AccountRef | null {
  if (!accounts.length) return null;
  const sameCurrency = accounts.filter((a) => a.currency === input.currency);
  const texts = [input.text, input.context ?? ""];
  // 1. Nombrada en el mensaje, entre las de la moneda.
  for (const t of texts) {
    const named = namedAccount(sameCurrency, t);
    if (named) return named;
  }
  // 2. Por el método o las palabras ("300 bs en efectivo" → Efectivo Bs, no Efectivo $).
  const byMethod = input.method ? METHOD_KIND[input.method] : undefined;
  const kinds: AccountKind[] = [];
  if (byMethod) kinds.push(byMethod.kind);
  const p = plain(input.text);
  for (const [re, kind] of KIND_WORDS) if (re.test(p)) kinds.push(kind);
  for (const kind of kinds) {
    const hit = sameCurrency.find((a) => a.kind === kind);
    if (hit) return hit;
  }
  // 3. Nombrada aunque sea de otra moneda: "pagué 10$ con Banesco" sale de la cuenta en Bs.
  if (!input.strictCurrency)
    for (const t of texts) {
      const named = namedAccount(accounts, t);
      if (named) return named;
    }
  if (input.preferKind) {
    const hit = sameCurrency.find((a) => a.kind === input.preferKind);
    if (hit) return hit;
  }
  return input.noFallback ? null : (sameCurrency[0] ?? null);
}

/** Una cuenta cuyo nombre aparece en el texto, o el mismo banco con otro nombre ("bdv"). */
export function namedAccount(accounts: AccountRef[], text: string): AccountRef | null {
  const p = ` ${plain(text).replace(/[^\p{L}\p{N}% ]/gu, " ")} `;
  if (!p.trim()) return null;
  // El nombre más largo primero: "Banesco Panamá" antes que "Banesco".
  const byLength = [...accounts].sort((a, b) => b.name.length - a.name.length);
  for (const a of byLength) {
    const n = plain(a.name)
      .replace(/[^\p{L}\p{N}% ]/gu, " ")
      .trim();
    if (n.length >= 3 && p.includes(` ${n} `)) return a;
  }
  const code = bankCode(p);
  if (code) {
    const same = accounts.filter((a) => bankCode(` ${plain(a.name)} `) === code);
    if (same.length === 1) return same[0] ?? null;
  }
  return null;
}

function bankCode(p: string): string | null {
  return BANK_ALIAS_CODE.find(([re]) => re.test(p))?.[1] ?? null;
}

async function audit(
  tx: Tx,
  tenantId: string,
  actor: Actor,
  channel: "whatsapp" | "dashboard",
  action: "create" | "update" | "delete",
  entityId: string,
  before: unknown,
  after: unknown,
) {
  await tx.insert(schema.auditLog).values({
    tenantId,
    actorType: actor.phoneId ? "phone" : "user",
    actorId: actor.phoneId ?? actor.userId ?? null,
    action,
    entity: "account",
    entityId,
    before,
    after,
    channel,
  });
}
