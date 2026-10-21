import { and, desc, eq, inArray, isNull, schema, sql, type Tx } from "@caja/db";
import { businessDateOf, type IsoDate } from "../domain/dates";
import { type Currency, Decimal } from "../domain/money";
import type { StarterAccount } from "../domain/starters";
import {
  AccountError,
  type AccountRef,
  accountBalances,
  createAccount,
  listAccounts,
  missingStarters,
  namedKinds,
  resolveAccount,
  starterById,
} from "../ledger/accounts";
import { AccountAsk, DRAFT_TTL_MS } from "../ledger/drafts";
import type { PaymentMethod } from "../ledger/income";
import { amendMovement, computeAmend } from "../ledger/last-movement";
import { es, type Outbound } from "../render/index";

/**
 * De qué cuenta fue, cuando Rocco no lo supo (PRD cash-in-drawer, fase 3). La tarjeta guardada
 * pregunta (US-004); un toque (US-005), una cuenta nueva (US-006) o una respuesta corta escrita
 * (US-007) la ponen en los movimientos de esa tarjeta que quedaron sin cuenta. Sin texto de
 * vuelta: un ✅ sobre el mensaje.
 */

/** Las tarjetas que pueden preguntar. */
export const ASK_KINDS: readonly string[] = [
  "create_expense",
  "create_expenses",
  "create_income_day_total",
  "create_income_single",
];

type AskCtx = {
  tenantId: string;
  phoneId: string;
  role: "owner" | "employee";
  inboundId: string;
  today: IsoDate;
};

type Pending = typeof schema.pendingAction.$inferSelect;

/** Movimientos vivos de la tarjeta que siguen sin cuenta. */
async function unassigned(tx: Tx, savedIds: string[] | null) {
  if (!savedIds?.length) return [];
  const m = schema.movement;
  return tx
    .select()
    .from(m)
    .where(and(inArray(m.id, savedIds), isNull(m.deletedAt), isNull(m.accountId)));
}

/** Lo que la tarjeta guardó en su payload para preguntar, si lo hay. */
function askOf(p: Pending): AccountAsk | null {
  const parsed = AccountAsk.safeParse((p.payload as { accountAsk?: unknown }).accountAsk);
  return parsed.success ? parsed.data : null;
}

/** Las de arranque que la tarjeta puede ofrecer: la que pidió el mensaje, si todavía falta. */
function offeredStarter(ask: AccountAsk, accounts: AccountRef[]): StarterAccount | null {
  const s = ask.starter ? starterById(ask.starter) : null;
  return s && missingStarters(accounts).some((m) => m.id === s.id) ? s : null;
}

/**
 * La respuesta corta escrita (US-007, ER-18): sin cifras, 5 palabras o menos, no una pregunta, y
 * que nombre una cuenta (o un tipo) que sea una de las permitidas, la misma en cada moneda de lo
 * que falta. La usan la respuesta escrita y el aviso C13 de la lista, para que no se separen.
 */
export function shortAccountAnswer(
  text: string,
  accounts: AccountRef[],
  currencies: Currency[],
  allowed: { candidates: string[]; starter: StarterAccount | null },
): { account: AccountRef } | { starter: StarterAccount } | null {
  const t = text.trim();
  if (!t || /\d/.test(t) || t.includes("?") || t.split(/\s+/).length > 5) return null;
  const plain = t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (
    /^[¿¡]?\s*(cuanto|cuanta|cuantos|cuantas|cual|cuales|que|como|donde|ver|mis|dame)\b/.test(plain)
  )
    return null;
  let found: AccountRef | null = null;
  for (const currency of currencies.length ? currencies : (["USD"] as Currency[])) {
    const a = resolveAccount(accounts, { currency, text: t, noFallback: true });
    if (!a || (found && found.id !== a.id)) {
      found = null;
      break;
    }
    found = a;
  }
  if (found) return allowed.candidates.includes(found.id) ? { account: found } : null;
  const s = allowed.starter;
  if (s && namedKinds(t).includes(s.kind)) {
    // "en efectivo" en una tarjeta en Bs sin Efectivo Bs: la de arranque (solo si la moneda cuadra).
    const ves = /\b(bs|bolivares|bolos)\b/.test(plain);
    const usd = /(\$|\b(dolares|usd)\b)/.test(plain);
    if ((ves && s.currency !== "VES") || (usd && s.currency !== "USD")) return null;
    return { starter: s };
  }
  return null;
}

/**
 * La pregunta de una tarjeta recién guardada (US-004), o null si no hay nada sin cuenta. Marca la
 * tarjeta con `askedAccount` para la respuesta escrita.
 */
export async function accountAskFor(
  tx: Tx,
  ctx: AskCtx,
  p: Pending,
  savedIds: string[],
): Promise<es.AccountAskView | null> {
  if (!ASK_KINDS.includes(p.kind)) return null;
  const ask = askOf(p);
  if (!ask) return null;
  const open = await unassigned(tx, savedIds);
  if (!open.length) return null;
  const accounts = await listAccounts(tx, ctx.tenantId);
  const owner = ctx.role === "owner";
  const balances = owner
    ? new Map((await accountBalances(tx, ctx.tenantId)).map((a) => [a.id, a.balance] as const))
    : null;
  const view = (a: AccountRef) => ({
    ...a,
    ...(balances ? { balance: balances.get(a.id) ?? null } : {}),
  });
  const candidates = accounts.filter((a) => ask.candidates.includes(a.id));
  const starter = offeredStarter(ask, accounts);
  const currencies = [...new Set(open.map((m) => m.currency as Currency))];
  await tx
    .update(schema.pendingAction)
    .set({ payload: sql`${schema.pendingAction.payload} || '{"askedAccount": true}'::jsonb` })
    .where(eq(schema.pendingAction.id, p.id));
  return {
    candidates: candidates.map(view),
    others: accounts.filter((a) => !ask.candidates.includes(a.id)).map(view),
    starter: starter ? { id: starter.id, name: starter.name } : null,
    varios:
      p.kind === "create_income_day_total" && open.some((m) => m.paymentMethod === "unspecified"),
    owner,
    // C13: la primera que no cupo y que "fue de {cuenta}" pone sin pasar por la IA.
    hintFor: (leftOut) =>
      leftOut.find((a) => {
        const r = shortAccountAnswer(`fue de ${a.name}`, accounts, currencies, {
          candidates: ask.candidates,
          starter: null,
        });
        return r && "account" in r && r.account.id === a.id;
      })?.name ?? null,
  };
}

/** El método de un renglón de venta "sin especificar", según la cuenta elegida (US-005). */
function methodFor(a: AccountRef): PaymentMethod | null {
  if (a.kind === "cash") return a.currency === "VES" ? "cash_ves" : "cash_usd";
  if (a.kind === "zelle") return "zelle";
  return null;
}

/** Pone la cuenta en lo que quedó sin cuenta de la tarjeta. Devuelve cuántos movimientos tocó. */
async function assign(tx: Tx, ctx: AskCtx, p: Pending, a: AccountRef, now: Date): Promise<number> {
  const open = await unassigned(tx, p.savedIds);
  for (const movement of open) {
    const method = movement.paymentMethod === "unspecified" ? methodFor(a) : null;
    const draft = await computeAmend(tx, {
      movement,
      categoryName: null,
      changes: {
        accountId: a.id,
        accountName: a.name,
        ...(method ? { paymentMethod: method } : {}),
      },
    });
    await amendMovement(tx, {
      tenantId: ctx.tenantId,
      draft,
      actor: { phoneId: ctx.phoneId },
      now,
    });
  }
  return open.length;
}

/** La tarjeta de este teléfono, ya guardada y sin deshacer; o la respuesta para el toque. */
async function savedCardFor(tx: Tx, ctx: AskCtx, pendingId: string): Promise<Pending | Outbound> {
  const [p] = await tx
    .select()
    .from(schema.pendingAction)
    .where(
      and(eq(schema.pendingAction.id, pendingId), eq(schema.pendingAction.phoneId, ctx.phoneId)),
    )
    .for("update");
  if (p?.status === "cancelled") return es.alreadyUndone();
  if (!p?.savedIds?.length) return es.confirmationExpired();
  return p;
}

/** Toque en una cuenta de la pregunta (US-005): la pone y responde con ✅. */
export async function payWithAccount(
  tx: Tx,
  ctx: AskCtx,
  pendingId: string,
  accountId: string,
  now: Date,
): Promise<Outbound> {
  const p = await savedCardFor(tx, ctx, pendingId);
  if ("type" in p) return p;
  const account = (await listAccounts(tx, ctx.tenantId)).find((a) => a.id === accountId);
  if (account) await assign(tx, ctx, p, account, now);
  return es.accountSet(ctx.inboundId);
}

/** "Varios métodos" (US-005, C12): igual que Corregir; el desglose escrito reemplaza la tarjeta. */
export async function paySplit(
  tx: Tx,
  ctx: AskCtx,
  pendingId: string,
  now: Date,
): Promise<Outbound> {
  const p = await savedCardFor(tx, ctx, pendingId);
  if ("type" in p) return p;
  const pa = schema.pendingAction;
  await tx
    .update(pa)
    .set({ payload: sql`${pa.payload} - 'fixing'` })
    .where(and(eq(pa.phoneId, ctx.phoneId), eq(pa.status, "pending")));
  await tx
    .update(pa)
    .set({
      status: "pending",
      resolvedAt: null,
      payload: sql`${pa.payload} || '{"fixing": true}'::jsonb`,
      expiresAt: new Date(now.getTime() + DRAFT_TTL_MS),
    })
    .where(eq(pa.id, p.id));
  return es.promptSplitMethods();
}

/** Toque en una cuenta de arranque (US-006): la crea en cero, la pone y lo dice (C10). */
export async function payWithNewAccount(
  tx: Tx,
  ctx: AskCtx,
  pendingId: string,
  starterId: string,
  now: Date,
  dashboardUrl: string,
): Promise<Outbound> {
  const p = await savedCardFor(tx, ctx, pendingId);
  if ("type" in p) return p;
  const starter = starterById(starterId);
  if (!starter) return es.confirmationExpired();
  const created = await starterAccount(tx, ctx, starter, now);
  if (created instanceof AccountError)
    return es.accountError(created.code, starter.name, dashboardUrl);
  const n = await assign(tx, ctx, p, created.account, now);
  if (!created.isNew) return es.accountSet(ctx.inboundId);
  return es.starterCreated({
    name: created.account.name,
    several: n > 1,
    owner: ctx.role === "owner",
    dashboardUrl,
  });
}

/** La cuenta de arranque: la activa con ese nombre si ya existe; si no, nueva sin saldo dicho. */
async function starterAccount(
  tx: Tx,
  ctx: AskCtx,
  starter: StarterAccount,
  now: Date,
): Promise<{ account: AccountRef; isNew: boolean } | AccountError> {
  const accounts = await listAccounts(tx, ctx.tenantId);
  const same = accounts.find((a) => a.name.toLowerCase() === starter.name.toLowerCase());
  if (same) return { account: same, isNew: false };
  try {
    await createAccount(tx, {
      tenantId: ctx.tenantId,
      name: starter.name,
      currency: starter.currency,
      kind: starter.kind,
      openingBalance: new Decimal(0),
      openingKnown: false,
      openingDate: businessDateOf(now),
      actor: { phoneId: ctx.phoneId },
      channel: "whatsapp",
    });
  } catch (err) {
    if (err instanceof AccountError) return err;
    throw err;
  }
  const fresh = (await listAccounts(tx, ctx.tenantId)).find((a) => a.name === starter.name);
  if (!fresh) return new AccountError("missing");
  return { account: fresh, isNew: true };
}

/**
 * Respuesta escrita a la pregunta (US-007): solo si la última tarjeta de este teléfono preguntó,
 * es del mismo día, todavía tiene algo sin cuenta y el texto pasa las guardas. Si no, null y
 * sigue la IA como siempre.
 */
export async function accountAnswer(
  tx: Tx,
  ctx: AskCtx,
  text: string,
  now: Date,
  dashboardUrl: string,
): Promise<Outbound | null> {
  const t = text.trim();
  if (!t || /\d/.test(t) || t.split(/\s+/).length > 5) return null;
  const pa = schema.pendingAction;
  const [p] = await tx
    .select()
    .from(pa)
    .where(and(eq(pa.phoneId, ctx.phoneId), sql`${pa.savedIds} is not null`))
    .orderBy(desc(pa.createdAt))
    .limit(1);
  if (!p || p.status === "cancelled" || !(p.payload as { askedAccount?: boolean }).askedAccount)
    return null;
  // El día de la tarjeta, con el reloj del turno (expires_at = creada + 15 min).
  if (businessDateOf(new Date(p.expiresAt.getTime() - DRAFT_TTL_MS)) !== ctx.today) return null;
  const ask = askOf(p);
  if (!ask) return null;
  const open = await unassigned(tx, p.savedIds);
  if (!open.length) return null;
  const accounts = await listAccounts(tx, ctx.tenantId);
  const hit = shortAccountAnswer(
    t,
    accounts,
    [...new Set(open.map((m) => m.currency as Currency))],
    {
      candidates: ask.candidates,
      starter: offeredStarter(ask, accounts),
    },
  );
  if (!hit) return null;
  if ("starter" in hit) return payWithNewAccount(tx, ctx, p.id, hit.starter.id, now, dashboardUrl);
  await assign(tx, ctx, p, hit.account, now);
  return es.accountSet(ctx.inboundId);
}
