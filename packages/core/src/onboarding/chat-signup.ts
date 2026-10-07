import { createHash, randomInt } from "node:crypto";
import { and, type Db, eq, gt, isNull, schema, sql, type Tx } from "@caja/db";
import { DEFAULT_EXPENSE_CATEGORIES } from "@caja/db/seed-data";
import { Decimal, parseVenezuelanAmount } from "../domain/money";
import type { AccountKind } from "../ledger/accounts";
import { es, type Outbound, parseReplyId } from "../render/index";
import {
  type BusinessType,
  CHAT_SIGNUP_MAX_ACCOUNTS,
  onboardingCategories,
  PhoneTakenError,
  plainName,
  registerFromChat,
} from "./register";

/**
 * Registro por WhatsApp (0018, pedido de Javier el 07/10/2026): quien le escribe a Rocco sin
 * cuenta la crea en el chat, con lo mismo que pide el asistente web. Todo determinista: sin LLM,
 * con botones donde se puede y parsers sencillos donde hay que escribir. Pasos:
 *
 *   name → kind → (biz_name → biz_type) → currency → categories → accounts → accounts_confirm
 *   → budget → done
 *
 * El paso y lo respondido viven en `app.signup` (uno por número); si la persona vuelve otro día,
 * sigue donde quedó. Al terminar se crea el negocio con el número ya activo.
 */
export const SIGNUP_STEPS = [
  "name",
  "kind",
  "biz_name",
  "biz_type",
  "currency",
  "categories",
  "accounts",
  "accounts_confirm",
  "budget",
  "done",
] as const;
export type SignupStep = (typeof SIGNUP_STEPS)[number];

export type SignupAccount = {
  name: string;
  currency: "USD" | "VES";
  kind: AccountKind;
  openingBalance: string;
};

export type SignupData = {
  name?: string | undefined;
  kind?: "personal" | "business" | undefined;
  businessName?: string | undefined;
  businessType?: BusinessType | undefined;
  currency?: "USD" | "VES" | undefined;
  categories?: string[] | undefined;
  /** Las escribió y falta confirmarlas. */
  pendingAccounts?: SignupAccount[] | undefined;
  accounts?: SignupAccount[] | undefined;
  budgets?: { category: string; amountUsd: string }[] | undefined;
};

export type SignupInput = {
  e164: string;
  waUserId: string | null;
  profileName: string | null;
  /** Texto escrito, o null si tocó un botón o mandó otra cosa. */
  text: string | null;
  /** Id del botón o de la fila de la lista. */
  replyId: string | null;
};

export type SignupConfig = { dashboardUrl: string };

export type SignupResult = {
  outbound: Outbound[];
  step: SignupStep;
  created?: { tenantId: string; phoneId: string };
};

/** Tope de registros nuevos por hora en toda la plataforma: protege de un spam masivo. */
export const SIGNUPS_PER_HOUR = 60;

const BUSINESS_KINDS: Exclude<BusinessType, "personal">[] = [
  "car_wash",
  "food",
  "retail",
  "services",
  "other",
];

/** ¿Hay cupo para empezar un registro nuevo? Los que ya empezaron siguen siempre. */
export async function canStartSignup(db: Db, e164: string, now: Date): Promise<boolean> {
  const s = schema.signup;
  const [own] = await db.select({ id: s.id }).from(s).where(eq(s.e164, e164));
  if (own) return true;
  const since = new Date(now.getTime() - 60 * 60_000);
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s)
    .where(gt(s.createdAt, since));
  return (r?.n ?? 0) < SIGNUPS_PER_HOUR;
}

/** Un paso del registro: lee lo que hay, aplica la respuesta y devuelve qué contestar. */
export async function handleSignup(
  db: Db,
  input: SignupInput,
  cfg: SignupConfig,
  now: Date = new Date(),
): Promise<SignupResult> {
  const s = schema.signup;
  const [row] = await db.select().from(s).where(eq(s.e164, input.e164));
  const profile = cleanProfileName(input.profileName);

  // Primer mensaje (o un registro viejo cuyo negocio ya no existe): presentación y nombre.
  if (!row || row.completedAt) {
    if (row) {
      await db
        .update(s)
        .set({
          step: "name",
          data: {},
          completedAt: null,
          tenantId: null,
          messages: 1,
          updatedAt: now,
        })
        .where(eq(s.id, row.id));
    } else {
      await db
        .insert(s)
        .values({
          e164: input.e164,
          waUserId: input.waUserId,
          profileName: input.profileName,
          step: "name",
          data: {},
          messages: 1,
        })
        .onConflictDoNothing();
    }
    return { outbound: [es.signupIntro(cfg.dashboardUrl, profile)], step: "name" };
  }

  let step = (SIGNUP_STEPS as readonly string[]).includes(row.step)
    ? (row.step as SignupStep)
    : "name";
  let data = (row.data ?? {}) as SignupData;
  const save = async (next: SignupStep, nextData: SignupData = data) => {
    step = next;
    data = nextData;
    await db
      .update(s)
      .set({ step: next, data: nextData, messages: row.messages + 1, updatedAt: now })
      .where(eq(s.id, row.id));
  };

  const text = input.text?.trim() ?? null;
  const reply = input.replyId ? parseReplyId(input.replyId) : null;
  const choice = reply?.kind === "signup" ? reply.value : null;

  // Atajos que valen en cualquier paso.
  if (text && /^(prefiero )?(la |en la )?(web|p[aá]gina)$/i.test(text)) {
    await save(step);
    return { outbound: [es.signupWeb(cfg.dashboardUrl)], step };
  }
  if (text && /^(empezar de nuevo|volver a empezar|reiniciar|empezar otra vez)$/i.test(text)) {
    await save("name", {});
    return { outbound: [es.signupAskName(profile)], step: "name" };
  }
  if (!text && !choice) {
    await save(step);
    return { outbound: [es.signupTextOnly(), prompt(step, data, profile)], step };
  }
  if (text && /^(ayuda|\?+|no entiendo|c[oó]mo es)$/i.test(text)) {
    await save(step);
    return { outbound: [es.signupHelp(), prompt(step, data, profile)], step };
  }

  switch (step) {
    case "name": {
      const name = choice === "name:profile" ? profile : text ? parsePersonName(text) : null;
      if (!name) {
        await save("name");
        return { outbound: [es.signupNameUnclear(profile)], step };
      }
      await save("kind", { ...data, name });
      return { outbound: [prompt("kind", data, profile)], step };
    }
    case "kind": {
      const kind =
        choice === "kind:personal"
          ? "personal"
          : choice === "kind:business"
            ? "business"
            : text
              ? parseKind(text)
              : null;
      if (!kind) {
        await save("kind");
        return { outbound: [prompt("kind", data, profile)], step };
      }
      if (kind === "personal") {
        await save("currency", {
          ...data,
          kind,
          businessType: "personal",
          businessName: undefined,
        });
        return { outbound: [prompt("currency", data, profile)], step };
      }
      await save("biz_name", { ...data, kind });
      return { outbound: [prompt("biz_name", data, profile)], step };
    }
    case "biz_name": {
      const name = text ? cleanText(text, 60) : null;
      if (!name || name.length < 2) {
        await save("biz_name");
        return { outbound: [prompt("biz_name", data, profile)], step };
      }
      await save("biz_type", { ...data, businessName: name });
      return { outbound: [prompt("biz_type", data, profile)], step };
    }
    case "biz_type": {
      const picked = choice?.startsWith("type:") ? choice.slice(5) : null;
      const type =
        picked && (BUSINESS_KINDS as string[]).includes(picked)
          ? (picked as BusinessType)
          : text
            ? parseBusinessType(text)
            : null;
      if (!type) {
        await save("biz_type");
        return { outbound: [prompt("biz_type", data, profile)], step };
      }
      await save("currency", { ...data, businessType: type });
      return { outbound: [prompt("currency", data, profile)], step };
    }
    case "currency": {
      const currency =
        choice === "cur:USD"
          ? "USD"
          : choice === "cur:VES"
            ? "VES"
            : text
              ? parseCurrency(text)
              : null;
      if (!currency) {
        await save("currency");
        return { outbound: [prompt("currency", data, profile)], step };
      }
      await save("categories", { ...data, currency });
      return { outbound: [prompt("categories", data, profile)], step };
    }
    case "categories": {
      const type = data.businessType ?? "personal";
      if (choice === "cat:edit") {
        await save("categories");
        return { outbound: [es.signupCategoriesWrite()], step };
      }
      let categories: string[] | null = null;
      if (choice === "cat:ok") categories = onboardingCategories(undefined, type);
      else if (text) categories = parseCategoryList(text, type);
      if (!categories) {
        await save("categories");
        return { outbound: [prompt("categories", data, profile)], step };
      }
      await save("accounts", { ...data, categories });
      return {
        outbound: [
          es.signupCategoriesSet(categories, cfg.dashboardUrl),
          prompt("accounts", data, profile),
        ],
        step,
      };
    }
    case "accounts":
    case "accounts_confirm": {
      if (choice === "acc:skip") {
        await save("budget", { ...data, accounts: [], pendingAccounts: undefined });
        return { outbound: [prompt("budget", data, profile)], step };
      }
      if (step === "accounts_confirm" && choice === "acc:ok") {
        await save("budget", {
          ...data,
          accounts: data.pendingAccounts ?? [],
          pendingAccounts: undefined,
        });
        return { outbound: [prompt("budget", data, profile)], step };
      }
      if (choice === "acc:edit") {
        await save("accounts", { ...data, pendingAccounts: undefined });
        return { outbound: [prompt("accounts", data, profile)], step };
      }
      const parsed = text ? parseAccounts(text, data.currency ?? "USD") : [];
      if (!parsed.length) {
        await save(step);
        return { outbound: [es.signupAccountsUnclear()], step };
      }
      await save("accounts_confirm", { ...data, pendingAccounts: parsed });
      return { outbound: [es.signupAccountsConfirm(parsed)], step };
    }
    case "budget": {
      let budgets: { category: string; amountUsd: string }[] = [];
      if (choice !== "bud:skip") {
        const parsed = text ? parseBudgets(text, data.categories ?? []) : null;
        if (!parsed?.length) {
          await save("budget");
          return { outbound: [es.signupBudgetUnclear(data.categories ?? [])], step };
        }
        budgets = parsed;
      }
      const final = { ...data, budgets };
      try {
        const created = await registerFromChat(
          db,
          {
            e164: input.e164,
            waUserId: input.waUserId,
            ownerName: final.name ?? profile ?? "",
            name:
              final.kind === "business"
                ? (final.businessName ?? final.name ?? "Mi negocio")
                : (final.name ?? profile ?? "Mis finanzas"),
            businessType: final.businessType ?? "personal",
            defaultExpenseCurrency: final.currency ?? "USD",
            categories: final.categories,
            accounts: final.accounts,
            budgets,
          },
          now,
        );
        await db
          .update(s)
          .set({
            step: "done",
            data: final,
            messages: row.messages + 1,
            tenantId: created.tenantId,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(s.id, row.id));
        return {
          outbound: [
            es.signupDone(doneView(final)),
            es.signupTour(cfg.dashboardUrl, final.kind ?? "personal"),
          ],
          step: "done",
          created,
        };
      } catch (err) {
        if (err instanceof PhoneTakenError) {
          await save("done", final);
          return { outbound: [es.signupTaken(cfg.dashboardUrl)], step: "done" };
        }
        throw err;
      }
    }
    default:
      await save("name", {});
      return { outbound: [es.signupAskName(profile)], step: "name" };
  }
}

function doneView(d: SignupData): Parameters<typeof es.signupDone>[0] {
  return {
    name: d.name ?? "",
    businessName: d.kind === "business" ? (d.businessName ?? null) : null,
    currency: d.currency ?? "USD",
    categories: d.categories ?? [],
    accounts: d.accounts ?? [],
    budgets: d.budgets ?? [],
  };
}

/** La pregunta de cada paso. */
function prompt(step: SignupStep, data: SignupData, profile: string | null): Outbound {
  switch (step) {
    case "name":
      return es.signupAskName(profile);
    case "kind":
      return es.signupAskKind(data.name ?? profile ?? "");
    case "biz_name":
      return es.signupAskBusinessName();
    case "biz_type":
      return es.signupAskBusinessType(data.businessName ?? "tu negocio");
    case "currency":
      return es.signupAskCurrency(data.kind === "business");
    case "categories":
      return es.signupAskCategories(
        onboardingCategories(undefined, data.businessType ?? "personal"),
        data.kind === "business",
      );
    case "accounts":
      return es.signupAskAccounts(data.kind === "business");
    case "accounts_confirm":
      return es.signupAccountsConfirm(data.pendingAccounts ?? []);
    case "budget":
      return es.signupAskBudget(data.categories ?? [], data.kind === "business");
    default:
      return es.signupAskName(profile);
  }
}

// ---------------------------------------------------------------- lectores de respuestas

/** Nombre de perfil de WhatsApp usable: el primer nombre, con letras, de 2 a 14 caracteres. */
export function cleanProfileName(raw: string | null): string | null {
  const first = raw?.trim().split(/\s+/)[0] ?? "";
  if (!/^\p{L}[\p{L}'-]{1,13}$/u.test(first)) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

const GREETING =
  /^(hola+|buenas?( noches| tardes| d[ií]as)?|hey|epa|saludos|ok|okey|s[ií]|no|listo|dale)[!.\s]*$/i;

/** "Me llamo Javier Ortiz" → "Javier Ortiz". Null si parece un saludo o no es un nombre. */
export function parsePersonName(text: string): string | null {
  const t = text
    .trim()
    .replace(/^(hola[,!.]?\s*)?(me llamo|mi nombre es|soy|ll[aá]mame|dime)\s+/i, "")
    .replace(/[.!¡]+$/g, "")
    .trim();
  if (!t || GREETING.test(t) || t.length > 40 || /\d/.test(t)) return null;
  if (!/^[\p{L}][\p{L}\s'.-]*$/u.test(t)) return null;
  if (t.split(/\s+/).length > 4) return null;
  return t
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function parseKind(text: string): "personal" | "business" | null {
  const t = plainName(text);
  if (/negocio|empresa|emprend|tienda|local|comercio|bodega|restaurant|trabajo/.test(t))
    return "business";
  if (/\b(mi|mio|para mi|personal|yo|uso personal|casa|familia|hogar)\b/.test(t)) return "personal";
  return null;
}

export function parseBusinessType(text: string): BusinessType {
  const t = plainName(text);
  if (/lavado|autolavado|car ?wash/.test(t)) return "car_wash";
  if (
    /comida|restaurant|arepa|arepera|panader|pizz|hamburg|cafe|dulce|reposter|food|bebida|licor|cocina/.test(
      t,
    )
  )
    return "food";
  if (/tienda|bodega|abasto|ropa|venta|mercancia|comercio|kiosko|kiosco|farmacia|ferreter/.test(t))
    return "retail";
  if (
    /servicio|taller|mecanic|peluquer|barber|salon|consult|asesor|tecnic|reparac|clase|delivery/.test(
      t,
    )
  )
    return "services";
  return "other";
}

export function parseCurrency(text: string): "USD" | "VES" | null {
  const t = plainName(text);
  if (/\$|dolar|usd|verde|usdt/.test(t)) return "USD";
  if (/\bbs\b|bolivar|\bves\b|bolo/.test(t)) return "VES";
  return null;
}

/** Separa una lista escrita: por líneas, punto y coma, o comas seguidas de una palabra. */
export function splitItems(text: string): string[] {
  return text
    .split(/\n|;|,(?=\s*[^\d\s])/u)
    .map((x) => x.replace(/^[\s•*\-–\d.)]+(?=\p{L})/u, "").trim())
    .filter(Boolean);
}

/**
 * Categorías escritas: "agrega Gimnasio, Mascotas" suma a las sugeridas; una lista sola las
 * reemplaza. Null si no hay ningún nombre.
 */
export function parseCategoryList(text: string, type: BusinessType): string[] | null {
  const add = /^(agrega|agregar|añade|añadir|suma|sumale|y tambi[eé]n|tambi[eé]n|\+)\s*:?\s*/i;
  const adding = add.test(text.trim());
  const names = splitItems(text.trim().replace(add, ""))
    .map((n) => n.replace(/[.!]+$/g, "").trim())
    .filter((n) => n.length >= 2 && n.length <= 40 && !/^\d+$/.test(n))
    .map((n) => n.charAt(0).toUpperCase() + n.slice(1));
  if (!names.length) return null;
  const base = adding ? [...(DEFAULT_EXPENSE_CATEGORIES[type] ?? []), ...names] : names;
  // Las sugeridas terminan en "Otros": se saca para que las nuevas no queden después del tope.
  const withoutOthers = base.filter((n) => plainName(n) !== "otros");
  return onboardingCategories(adding ? [...names, ...withoutOthers] : withoutOthers, type);
}

const CUR_USDT = /\busdt\b|\btether\b/i;
const CUR_USD = /\$|\busd\b|d[oó]lar(es)?|\bverdes\b/i;
const CUR_VES = /\bbs\b\.?|\bbsf?\b|bol[ií]var(es)?|\bves\b|\bbolos?\b/i;
const AMOUNT = /(\d[\d.,]*)\s*(k|mil)?\b/i;

function amountOf(text: string): Decimal | null {
  const m = AMOUNT.exec(text);
  if (!m?.[1]) return null;
  const n = parseVenezuelanAmount(m[1].replace(/[.,]$/, ""));
  if (!n) return null;
  return m[2] ? n.mul(1000) : n;
}

const FILLER =
  /^(con|tengo|hay|en|de|del|saldo|cuenta|mi|mis|el|la|los|las|al mes|al|mes|mensual(es)?|tope|m[aá]ximo|para|y|a|por)$/i;

/** Quita monto, moneda y palabras de relleno al principio y al final: "con Banesco 5.000 bs" → "Banesco". */
function stripMoney(text: string): string {
  const words = text
    .replace(AMOUNT, " ")
    .replace(CUR_USDT, " ")
    .replace(CUR_USD, " ")
    .replace(CUR_VES, " ")
    .replace(/[:=\-–]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  while (words.length && FILLER.test(words[0] ?? "")) words.shift();
  while (words.length && FILLER.test(words[words.length - 1] ?? "")) words.pop();
  return words.join(" ");
}

function kindOf(name: string): AccountKind {
  const t = plainName(name);
  if (/binance|usdt|cripto|crypto|airtm|reserve|wally|zinli|paypal/.test(t)) return "crypto";
  if (/zelle/.test(t)) return "zelle";
  if (/efectivo|cash|billete|caja chica|bolsillo/.test(t)) return "cash";
  if (
    /banco|banesco|mercantil|provincial|bdv|venezuela|bnc|bancamiga|bicentenario|tesoro|exterior|plaza|caroni|sofitasa|activo|banplus|bancaribe|fondo comun|bfc|100%|del sur|mi banco|banca amiga/.test(
      t,
    )
  )
    return "bank";
  return "other";
}

/**
 * Cuentas escritas, una por renglón o separadas por coma: "Banesco 5.000 bs", "Binance 120 usdt",
 * "efectivo 40$". Sin moneda, la deduce del tipo (Binance y Zelle en dólares, bancos en Bs).
 */
export function parseAccounts(text: string, defaultCurrency: "USD" | "VES"): SignupAccount[] {
  const out: SignupAccount[] = [];
  for (const item of splitItems(text)) {
    const amount = amountOf(item) ?? new Decimal(0);
    let name = stripMoney(item);
    if (!/\p{L}/u.test(name)) {
      if (CUR_USDT.test(item)) name = "Binance";
      else continue;
    }
    name = name.charAt(0).toUpperCase() + name.slice(1);
    if (name.length > 30) name = name.slice(0, 30).trim();
    let kind = kindOf(name);
    if (CUR_USDT.test(item)) kind = "crypto";
    const currency: "USD" | "VES" = CUR_USDT.test(item)
      ? "USD"
      : CUR_USD.test(item)
        ? "USD"
        : CUR_VES.test(item)
          ? "VES"
          : kind === "crypto" || kind === "zelle"
            ? "USD"
            : kind === "bank"
              ? "VES"
              : defaultCurrency;
    if (out.some((a) => plainName(a.name) === plainName(name))) continue;
    out.push({ name, currency, kind, openingBalance: amount.toFixed(2) });
    if (out.length >= CHAT_SIGNUP_MAX_ACCOUNTS) break;
  }
  return out;
}

/** "Mercado 200, comida fuera 80$" → topes mensuales en dólares de categorías que existen. */
export function parseBudgets(
  text: string,
  categories: string[],
): { category: string; amountUsd: string }[] {
  const out: { category: string; amountUsd: string }[] = [];
  for (const item of splitItems(text)) {
    if (CUR_VES.test(item)) continue;
    const amount = amountOf(item);
    if (!amount || amount.lte(0)) continue;
    const words = plainName(stripMoney(item));
    if (!words) continue;
    const match = categories.find((c) => {
      const p = plainName(c);
      if (p === "otros" && words !== "otros") return false;
      return (
        p === words ||
        p.includes(words) ||
        words.includes(p) ||
        p.split(" ").some((w) => w.length >= 4 && words.split(" ").includes(w))
      );
    });
    if (!match || out.some((b) => b.category === match)) continue;
    out.push({ category: match, amountUsd: amount.toFixed(2) });
  }
  return out;
}

const cleanText = (t: string, max: number) => t.replace(/\s+/g, " ").trim().slice(0, max);

// ---------------------------------------------------------------- conectar el panel (0018)

export const LINK_TTL_MS = 15 * 60_000;
const linkHash = (code: string) =>
  createHash("sha256").update(`dashboard-link:${code}`).digest("hex");

/**
 * El usuario del panel (ya con correo verificado) pide conectar un negocio creado por WhatsApp:
 * recibe un código que manda a Rocco desde su número. Vence los anteriores del mismo usuario.
 */
export async function createDashboardLink(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<{ code: string; expiresAt: Date }> {
  const l = schema.dashboardLink;
  await db
    .update(l)
    .set({ expiresAt: now })
    .where(and(eq(l.userId, userId), isNull(l.usedAt), gt(l.expiresAt, now)));
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS);
  await db.insert(l).values({ userId, codeHash: linkHash(code), expiresAt });
  return { code, expiresAt };
}

/**
 * El dueño mandó por WhatsApp un código de 6 dígitos: si es de un enlace vigente, su usuario del
 * panel queda como dueño de este negocio. Devuelve el correo, o null si el código no es de enlace.
 */
export async function redeemDashboardLink(
  tx: Tx,
  ref: { tenantId: string; phoneId: string },
  code: string,
  now: Date = new Date(),
): Promise<{ email: string } | null> {
  const l = schema.dashboardLink;
  const [open] = await tx
    .select()
    .from(l)
    .where(and(eq(l.codeHash, linkHash(code)), isNull(l.usedAt), gt(l.expiresAt, now)))
    .limit(1);
  if (!open) return null;
  await tx.update(l).set({ usedAt: now, tenantId: ref.tenantId }).where(eq(l.id, open.id));
  await tx
    .insert(schema.tenantMember)
    .values({ tenantId: ref.tenantId, userId: open.userId, role: "owner" })
    .onConflictDoNothing();
  await tx.insert(schema.auditLog).values({
    tenantId: ref.tenantId,
    actorType: "phone",
    actorId: ref.phoneId,
    action: "create",
    entity: "tenant_member",
    entityId: open.userId,
    before: null,
    after: { userId: open.userId, role: "owner" },
    channel: "whatsapp",
  });
  const [u] = await tx
    .select({ email: schema.userAccount.email })
    .from(schema.userAccount)
    .where(eq(schema.userAccount.id, open.userId));
  return { email: u?.email ?? "" };
}

/** ¿Este negocio ya tiene a alguien en el panel? Para el "link del dashboard". */
export async function hasDashboardMember(tx: Tx, tenantId: string): Promise<boolean> {
  const [m] = await tx
    .select({ id: schema.tenantMember.userId })
    .from(schema.tenantMember)
    .where(eq(schema.tenantMember.tenantId, tenantId))
    .limit(1);
  return Boolean(m);
}
