import { and, asc, eq, gt, isNull, rows, schema, sql, type Tx } from "@caja/db";
import { addDays, type IsoDate } from "../domain/dates";
import { type Currency, Decimal } from "../domain/money";
import { BANK_ALIAS_CODE } from "../domain/pago-movil";
import { STARTER_ACCOUNTS, type StarterAccount } from "../domain/starters";
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
 * Saldo de cada cuenta activa, todo en SQL: saldo inicial, movimientos, cambios y transferencias
 * (0014). Un movimiento en otra moneda que la cuenta cuenta por
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
          + coalesce((select sum(t.to_amount) from ${schema.accountTransfer} t
              where t.to_account_id = a.id and t.deleted_at is null), 0)
          - coalesce((select sum(t.from_amount) from ${schema.accountTransfer} t
              where t.from_account_id = a.id and t.deleted_at is null), 0)
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

export type AccountDay = AccountRef & {
  /** Lo que entró y salió de la cuenta ese día, en su moneda (siempre positivos). */
  in: Decimal;
  out: Decimal;
  net: Decimal;
  /** Saldo al final de ese día. */
  balanceEnd: Decimal;
};

/**
 * Entradas, salidas y saldo al cierre de un día, por cuenta activa (PRD cash-in-drawer, US-002).
 * Cuenta las mismas filas que `accountBalances` con la misma regla de moneda; el saldo inicial
 * entra solo desde su fecha de apertura, y un movimiento anterior a la apertura igual cuenta (un
 * saldo es un saldo). Para hoy coincide con `accountBalances`, porque no hay fechas futuras.
 */
export async function accountDays(tx: Tx, tenantId: string, date: IsoDate): Promise<AccountDay[]> {
  const found = rows<{
    id: string;
    name: string;
    currency: string;
    kind: string;
    in_amount: string;
    out_amount: string;
    balance_end: string;
  }>(
    await tx.execute(sql`
      with acc as (
        select id, name, currency, kind, opening_balance, opening_date, sort_order, created_at
        from ${schema.account}
        where tenant_id = ${tenantId} and archived_at is null
      ),
      items as (
        select m.account_id as id, m.business_date as d,
          (case when m.type = 'income' then 1 else -1 end)
          * (case when m.currency = a.currency then m.amount
                  when a.currency = 'USD' then m.amount_usd
                  else m.amount_ves end) as v
        from ${schema.movement} m join acc a on a.id = m.account_id
        where m.deleted_at is null
        union all
        select l.account_id, l.business_date, l.ves_amount
        from ${schema.exchangeLot} l join acc a on a.id = l.account_id
        where l.source = 'exchange' and l.deleted_at is null and l.adopted_at is null
        union all
        select l.from_account_id, l.business_date, -l.usd_amount
        from ${schema.exchangeLot} l join acc a on a.id = l.from_account_id
        where l.source = 'exchange' and l.deleted_at is null
        union all
        select t.to_account_id, t.business_date, t.to_amount
        from ${schema.accountTransfer} t join acc a on a.id = t.to_account_id
        where t.deleted_at is null
        union all
        select t.from_account_id, t.business_date, -t.from_amount
        from ${schema.accountTransfer} t join acc a on a.id = t.from_account_id
        where t.deleted_at is null
      )
      select a.id, a.name, a.currency, a.kind,
        coalesce(sum(i.v) filter (where i.d = ${date}::date and i.v > 0), 0)::text as in_amount,
        coalesce(-sum(i.v) filter (where i.d = ${date}::date and i.v < 0), 0)::text as out_amount,
        ((case when a.opening_date <= ${date}::date then a.opening_balance else 0 end)
          + coalesce(sum(i.v) filter (where i.d <= ${date}::date), 0))::text as balance_end
      from acc a left join items i on i.id = a.id
      group by a.id, a.name, a.currency, a.kind, a.opening_balance, a.opening_date, a.sort_order,
        a.created_at
      order by a.sort_order, a.created_at
    `),
  );
  return found.map((r) => {
    const inAmount = new Decimal(r.in_amount);
    const outAmount = new Decimal(r.out_amount);
    return {
      id: r.id,
      name: r.name,
      currency: r.currency as Currency,
      kind: r.kind as AccountKind,
      in: inAmount,
      out: outAmount,
      net: inAmount.minus(outAmount),
      balanceEnd: new Decimal(r.balance_end),
    };
  });
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
 * Crea una cuenta. En Bs, el saldo inicial queda como lote a la BCV del día de apertura. Una cuenta
 * en Bs que no es de efectivo adopta los cambios de antes de las cuentas (lotes sin cuenta): sus Bs
 * restantes son parte del saldo inicial, y solo el resto va a la BCV. Si el usuario no dijo el saldo
 * (`openingKnown` false), los lotes pasan enteros y su suma es el saldo inicial: crear "Banesco" sin
 * saldo nunca borra Bs. El efectivo no adopta: esos Bs están en un banco, no en la gaveta.
 */
export async function createAccount(
  tx: Tx,
  input: {
    tenantId: string;
    name: string;
    currency: Currency;
    kind: AccountKind;
    openingBalance: Decimal;
    /** El usuario escribió un saldo (un "0" escrito cuenta); si no, `openingBalance` es 0. */
    openingKnown: boolean;
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
  let created = row;
  if (input.currency === "VES") {
    const adopted =
      input.kind === "cash"
        ? D0
        : await adoptLegacyLots(
            tx,
            input.tenantId,
            row.id,
            input.openingKnown ? input.openingBalance : null,
          );
    if (!input.openingKnown && adopted.gt(0)) {
      const [updated] = await tx
        .update(a)
        .set({ openingBalance: adopted.toFixed(2) })
        .where(eq(a.id, row.id))
        .returning();
      if (updated) created = updated;
    }
    const rest = input.openingBalance.minus(adopted);
    if (rest.gt(0)) await adjustOpeningLot(tx, input.tenantId, row.id, input.openingDate, rest);
  }
  await audit(tx, input.tenantId, input.actor, input.channel, "create", row.id, null, created);
  return { id: row.id, name: row.name, currency: input.currency, kind: input.kind };
}

/**
 * Pasa a la cuenta los lotes sin cuenta con saldo. Si el saldo inicial dicho es menor que lo que
 * queda de esos cambios, se descuenta de los más viejos (se gastaron sin anotar). Sin saldo dicho
 * (`opening` null) pasan enteros. Devuelve los Bs adoptados.
 */
async function adoptLegacyLots(
  tx: Tx,
  tenantId: string,
  accountId: string,
  opening: Decimal | null,
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
  let trim = opening ? Decimal.max(D0, total.minus(Decimal.max(D0, opening))) : D0;
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
  return opening ? Decimal.min(total, Decimal.max(D0, opening)) : total;
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
  [/\b(pago ?movil|punto|transferencia|transferi|debito|tarjeta|banco)\b/, "bank"],
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
    /**
     * Gastos (16/10): en Venezuela un precio en $ casi siempre se paga en Bs. Un gasto en dólares
     * sin cuenta dicha sale de la principal en Bs (a la BCV); la de dólares solo si se nombra o
     * dice Zelle, efectivo o Binance. Pago móvil, punto o transferencia son de un banco en Bs.
     */
    dollarsFromBs?: boolean;
    /**
     * Renglón de un desglose de varios métodos ("200 efectivo, 100 pago móvil"): las palabras del
     * mensaje son de todos los renglones, así que manda el método del renglón; el texto solo elige
     * entre las cuentas de ese tipo ("pago móvil a Banesco"). Sin método, la principal.
     */
    lineOnly?: boolean;
  },
): AccountRef | null {
  if (!accounts.length) return null;
  const sameCurrency = accounts.filter((a) => a.currency === input.currency);
  if (input.lineOnly) return lineAccount(accounts, sameCurrency, input);
  const bsInstead = input.dollarsFromBs === true && input.currency === "USD";
  const bs = accounts.filter((a) => a.currency === "VES");
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
  // Un método de banco dice su moneda: pago móvil, punto o transferencia en Bs van al banco en Bs
  // aunque la venta se diga en $ (cash y zelle siguen la moneda del monto: son billetes o dólares).
  if (byMethod?.kind === "bank" && !input.strictCurrency) {
    const banks = accounts.filter((a) => a.kind === "bank" && a.currency === byMethod.currency);
    for (const t of texts) {
      const named = namedAccount(banks, t);
      if (named) return named;
    }
    if (banks[0]) return banks[0];
  }
  for (const kind of kinds) {
    // Pago móvil, punto o transferencia con un monto en $: el banco en Bs, no la cuenta en $.
    const pool = bsInstead && kind === "bank" && bs.length ? bs : sameCurrency;
    const hit = pool.find((a) => a.kind === kind);
    if (hit) return hit;
  }
  // 3. Nombrada aunque sea de otra moneda: "pagué 10$ con Banesco" sale de la cuenta en Bs. Si se
  // va a preguntar (sin la principal), un nombre que solo dice el tipo ("Efectivo $") no cuenta:
  // "en efectivo" en Bs no es esa cuenta.
  if (!input.strictCurrency)
    for (const t of texts) {
      const named = namedAccount(
        input.noFallback ? accounts.filter((a) => !genericName(a.name)) : accounts,
        t,
      );
      if (named) return named;
    }
  if (input.preferKind) {
    const hit = sameCurrency.find((a) => a.kind === input.preferKind);
    if (hit) return hit;
  }
  if (input.noFallback) return null;
  if (bsInstead && bs.length) return bs.find((a) => a.kind === "bank") ?? bs[0] ?? null;
  return sameCurrency[0] ?? null;
}

/** La cuenta de un renglón de un desglose: por su método (un banco, en la moneda del método). */
function lineAccount(
  accounts: AccountRef[],
  sameCurrency: AccountRef[],
  input: { text: string; context?: string; method?: PaymentMethod | null; noFallback?: boolean },
): AccountRef | null {
  const m = input.method ? METHOD_KIND[input.method] : undefined;
  if (m) {
    const ofKind = (pool: AccountRef[]) => pool.filter((a) => a.kind === m.kind);
    const inMethodCurrency =
      m.kind === "bank" ? ofKind(accounts.filter((a) => a.currency === m.currency)) : [];
    const pool = inMethodCurrency.length ? inMethodCurrency : ofKind(sameCurrency);
    if (pool.length) {
      for (const t of [input.text, input.context ?? ""]) {
        const named = namedAccount(pool, t);
        if (named) return named;
      }
      return pool[0] ?? null;
    }
  }
  return input.noFallback ? null : (sameCurrency[0] ?? null);
}

// ---------------------------------------------------------------- de qué cuenta fue (fase 3)

/** Cómo se eligió la cuenta de un movimiento (PRD cash-in-drawer US-003, métricas §7). */
export type AccountSource = "stated" | "only" | "learned";

export function starterById(id: string): StarterAccount | null {
  return STARTER_ACCOUNTS.find((s) => s.id === id) ?? null;
}

/** Las de arranque que el negocio todavía no tiene (ninguna activa de ese tipo y moneda). */
export function missingStarters(accounts: AccountRef[]): StarterAccount[] {
  return STARTER_ACCOUNTS.filter(
    (s) => !accounts.some((a) => a.kind === s.kind && a.currency === s.currency),
  );
}

/**
 * La de arranque para un tipo dicho en una moneda ("en efectivo" en Bs → Efectivo Bs), si el
 * negocio no tiene ninguna así. Un banco siempre es en Bs (pago móvil, punto, transferencia).
 */
export function starterFor(
  accounts: AccountRef[],
  kind: AccountKind,
  currency: Currency,
): StarterAccount | null {
  const cur = kind === "bank" ? "VES" : kind === "zelle" || kind === "crypto" ? "USD" : currency;
  const hit = STARTER_ACCOUNTS.find((s) => s.kind === kind && s.currency === cur) ?? null;
  return hit && missingStarters(accounts).some((s) => s.id === hit.id) ? hit : null;
}

/** Tipos de cuenta que dice un texto o un método ("en efectivo", "por pago móvil"). */
export function namedKinds(text: string, method?: PaymentMethod | null): AccountKind[] {
  const kinds: AccountKind[] = [];
  const m = method ? METHOD_KIND[method] : undefined;
  if (m) kinds.push(m.kind);
  const p = plain(text);
  for (const [re, kind] of KIND_WORDS) if (re.test(p) && !kinds.includes(kind)) kinds.push(kind);
  return kinds;
}

/**
 * Las cuentas posibles de un movimiento (US-003 paso 2, ER-16). Un monto en $: las cuentas en $
 * y la principal en Bs (en Venezuela un precio en $ se paga muchas veces en Bs). En Bs: las de Bs.
 * Si el mensaje dijo un tipo, solo las de ese tipo (un banco, en Bs). En el orden del dueño.
 */
export function accountCandidates(
  accounts: AccountRef[],
  currency: Currency,
  kind?: AccountKind | null,
): AccountRef[] {
  if (kind === "bank") return accounts.filter((a) => a.kind === "bank" && a.currency === "VES");
  const bs = accounts.filter((a) => a.currency === "VES");
  const mainBs = bs.find((a) => a.kind === "bank") ?? bs[0];
  const pool =
    currency === "USD" ? accounts.filter((a) => a.currency === "USD" || a.id === mainBs?.id) : bs;
  return kind ? pool.filter((a) => a.kind === kind) : pool;
}

/** Días hacia atrás que mira la cuenta aprendida (US-003 paso 3, ER-17). */
export const LEARNED_DAYS = 30;

/**
 * La cuenta de siempre para esto (ER-17): en los movimientos del mismo tipo de los últimos 30 días
 * (por fecha del movimiento y con su cuenta de hoy). Por descripción: 2 o más con cuenta y una con
 * 2/3 o más. Si hubo 2 o más por descripción sin mayoría, no se mira la categoría: varía, se
 * pregunta. Si no, por categoría: 3 o más y una con 2/3. Tiene que ser una de las candidatas.
 */
export async function learnedAccount(
  tx: Tx,
  input: {
    tenantId: string;
    type: "expense" | "income";
    description: string | null;
    categoryId: string | null;
    today: IsoDate;
    candidates: AccountRef[];
  },
): Promise<AccountRef | null> {
  if (!input.candidates.length) return null;
  const m = schema.movement;
  const found = await tx
    .select({ accountId: m.accountId, description: m.description, categoryId: m.categoryId })
    .from(m)
    .where(
      and(
        eq(m.tenantId, input.tenantId),
        eq(m.type, input.type),
        isNull(m.deletedAt),
        sql`${m.accountId} is not null`,
        gt(m.businessDate, addDays(input.today, -LEARNED_DAYS)),
      ),
    );
  const majority = (rows: { accountId: string | null }[]) => {
    const counts = new Map<string, number>();
    for (const r of rows)
      if (r.accountId) counts.set(r.accountId, (counts.get(r.accountId) ?? 0) + 1);
    const [id, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    return id && n * 3 >= rows.length * 2 ? id : null;
  };
  const pick = (id: string | null) => input.candidates.find((a) => a.id === id) ?? null;
  const desc = input.description ? plain(input.description) : "";
  if (desc) {
    const same = found.filter((r) => r.description && plain(r.description) === desc);
    if (same.length >= 2) return pick(majority(same));
  }
  if (input.categoryId) {
    const same = found.filter((r) => r.categoryId === input.categoryId);
    if (same.length >= 3) return pick(majority(same));
  }
  return null;
}

/** Un nombre que es solo el tipo de cuenta y la moneda: "Efectivo $", "Efectivo Bs", "Zelle". */
function genericName(name: string): boolean {
  const n = plain(name)
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\b(bs|usd|dolares|bolivares|en)\b/g, " ")
    .trim();
  return /^(efectivo|cash|zelle|binance|usdt|banco)$/.test(n);
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

/**
 * La cuenta que alguien nombra con palabras sueltas ("binance", "el efectivo", "bdv", "zelle"):
 * por nombre o apodo del banco; si no, por tipo cuando hay una sola de ese tipo.
 */
export function accountFromWords(accounts: AccountRef[], words: string): AccountRef | null {
  const named = namedAccount(accounts, words);
  if (named) return named;
  const p = plain(words);
  if (!p) return null;
  for (const [re, kind] of KIND_WORDS) {
    if (!re.test(p)) continue;
    const same = accounts.filter((a) => a.kind === kind);
    if (same.length === 1) return same[0] ?? null;
    // "efectivo en bs" / "efectivo $": la moneda desempata.
    const ves = /\b(bs|bolivares|bolos)\b/.test(p);
    const usd = /(\$|\b(dolares|usd)\b)/.test(p);
    const hit = same.find((a) => (ves && a.currency === "VES") || (usd && a.currency === "USD"));
    if (hit) return hit;
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

// ---------------------------------------------------------------- estado de cuenta

export type StatementKind =
  | "opening"
  | "expense"
  | "income"
  | "exchange_in"
  | "exchange_out"
  | "transfer_in"
  | "transfer_out";

export type StatementEntry = {
  kind: StatementKind;
  date: string;
  /** Con signo, en la moneda de la cuenta. */
  amount: Decimal;
  /** Saldo de la cuenta después de esta línea. */
  balanceAfter: Decimal;
  /** Descripción o categoría del movimiento; la otra cuenta en cambios y transferencias. */
  label: string | null;
  /** Cambios: USDT y tasa. Compra de USDT: Bs y USDT. */
  usd: Decimal | null;
  rate: Decimal | null;
  movementId: string | null;
  transferId: string | null;
  lotId: string | null;
};

export type AccountStatement = {
  account: AccountView;
  /** Lo más reciente primero. */
  entries: StatementEntry[];
  /** Entró y salió en el rango [from, to] (sin el saldo inicial). */
  period: { from: IsoDate; to: IsoDate; in: Decimal; out: Decimal };
};

/**
 * Estado de cuenta (0014): cada cosa que movió la cuenta con el saldo después, como un extracto
 * del banco. Los lotes adoptados no salen (ya están en el saldo inicial). `limit` líneas, las más
 * recientes; `period` suma lo que entró y salió en el rango.
 */
export async function accountStatement(
  tx: Tx,
  tenantId: string,
  accountId: string,
  opts: { limit?: number; from: IsoDate; to: IsoDate },
): Promise<AccountStatement | null> {
  const account = await accountBalance(tx, tenantId, accountId);
  if (!account) return null;
  const found = rows<{
    kind: StatementKind;
    date: string;
    amount: string;
    balance_after: string;
    label: string | null;
    usd: string | null;
    rate: string | null;
    movement_id: string | null;
    transfer_id: string | null;
    lot_id: string | null;
  }>(
    await tx.execute(sql`
      with a as (
        select id, currency, opening_balance, opening_date, created_at
        from ${schema.account} where id = ${accountId} and tenant_id = ${tenantId}
      ), e as (
        select 'opening'::text as kind, a.opening_date as date, a.opening_balance as amount,
          a.created_at as at, null::text as label, null::numeric as usd, null::numeric as rate,
          null::uuid as movement_id, null::uuid as transfer_id, null::uuid as lot_id, 0 as ord
        from a
        union all
        select m.type, m.business_date,
          (case when m.type = 'income' then 1 else -1 end)
            * (case when m.currency = a.currency then m.amount
                    when a.currency = 'USD' then m.amount_usd else m.amount_ves end),
          m.created_at, coalesce(m.description, c.name), null, null, m.id, null, null, 1
        from ${schema.movement} m
        cross join a
        left join ${schema.category} c on c.id = m.category_id
        where m.account_id = a.id and m.deleted_at is null
        union all
        select 'exchange_in', l.business_date, l.ves_amount, l.created_at, fa.name,
          l.usd_amount, l.rate, null, null, l.id, 1
        from ${schema.exchangeLot} l
        cross join a
        left join ${schema.account} fa on fa.id = l.from_account_id
        where l.account_id = a.id and l.source = 'exchange' and l.deleted_at is null
          and l.adopted_at is null
        union all
        select 'exchange_out', l.business_date, -l.usd_amount, l.created_at, ta.name,
          l.usd_amount, l.rate, null, null, l.id, 1
        from ${schema.exchangeLot} l
        cross join a
        left join ${schema.account} ta on ta.id = l.account_id
        where l.from_account_id = a.id and l.source = 'exchange' and l.deleted_at is null
        union all
        select 'transfer_in', t.business_date, t.to_amount, t.created_at, fa.name,
          case when t.from_amount <> t.to_amount then t.from_amount end, null, null, t.id, null, 1
        from ${schema.accountTransfer} t
        cross join a
        join ${schema.account} fa on fa.id = t.from_account_id
        where t.to_account_id = a.id and t.deleted_at is null
        union all
        select 'transfer_out', t.business_date, -t.from_amount, t.created_at, ta.name,
          case when t.from_amount <> t.to_amount then t.to_amount end, null, null, t.id, null, 1
        from ${schema.accountTransfer} t
        cross join a
        join ${schema.account} ta on ta.id = t.to_account_id
        where t.from_account_id = a.id and t.deleted_at is null
      ), r as (
        select e.*, sum(amount) over (order by ord, date, at rows unbounded preceding) as bal
        from e
      )
      select kind, date::text, amount::text, bal::text as balance_after, label, usd::text,
        rate::text, movement_id, transfer_id, lot_id
      from r order by ord desc, date desc, at desc
      limit ${opts.limit ?? 50}
    `),
  );
  const totals = rows<{ inflow: string; outflow: string }>(
    await tx.execute(sql`
      with a as (select id, currency from ${schema.account} where id = ${accountId}),
      e as (
        select (case when m.type = 'income' then 1 else -1 end)
            * (case when m.currency = a.currency then m.amount
                    when a.currency = 'USD' then m.amount_usd else m.amount_ves end) as amount
        from ${schema.movement} m cross join a
        where m.account_id = a.id and m.deleted_at is null
          and m.business_date between ${opts.from}::date and ${opts.to}::date
        union all
        select l.ves_amount from ${schema.exchangeLot} l cross join a
        where l.account_id = a.id and l.source = 'exchange' and l.deleted_at is null
          and l.adopted_at is null and l.business_date between ${opts.from}::date and ${opts.to}::date
        union all
        select -l.usd_amount from ${schema.exchangeLot} l cross join a
        where l.from_account_id = a.id and l.source = 'exchange' and l.deleted_at is null
          and l.business_date between ${opts.from}::date and ${opts.to}::date
        union all
        select t.to_amount from ${schema.accountTransfer} t cross join a
        where t.to_account_id = a.id and t.deleted_at is null
          and t.business_date between ${opts.from}::date and ${opts.to}::date
        union all
        select -t.from_amount from ${schema.accountTransfer} t cross join a
        where t.from_account_id = a.id and t.deleted_at is null
          and t.business_date between ${opts.from}::date and ${opts.to}::date
      )
      select coalesce(sum(amount) filter (where amount > 0), 0)::text as inflow,
             coalesce(-sum(amount) filter (where amount < 0), 0)::text as outflow
      from e
    `),
  );
  const dec = (v: string | null) => (v === null ? null : new Decimal(v));
  return {
    account,
    entries: found.map((r) => ({
      kind: r.kind,
      date: r.date,
      amount: new Decimal(r.amount),
      balanceAfter: new Decimal(r.balance_after),
      label: r.label,
      usd: dec(r.usd),
      rate: dec(r.rate),
      movementId: r.movement_id,
      transferId: r.transfer_id,
      lotId: r.lot_id,
    })),
    period: {
      from: opts.from,
      to: opts.to,
      in: new Decimal(totals[0]?.inflow ?? 0),
      out: new Decimal(totals[0]?.outflow ?? 0),
    },
  };
}
