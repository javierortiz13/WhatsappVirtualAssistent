import { createHash, randomInt } from "node:crypto";
import { and, type Db, eq, gt, isNull, schema, sql, type Tx } from "@caja/db";
import { DEFAULT_EXPENSE_CATEGORIES } from "@caja/db/seed-data";
import { TRIAL_MESSAGES } from "../billing/plans";
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
 *   name → kind → (biz_name → biz_type) → currency → categories → budget → done
 *
 * Desde la auditoría del 26/10 el registro ya no pide cuentas (ahí se quedaba la mitad de los que
 * no terminaban): se crean después, por el chat o en el panel. `accounts` y `accounts_confirm`
 * siguen en la lista solo para leer los registros viejos que quedaron en esos pasos.
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
  if (
    text &&
    /^(empezar de nuevo|volver a empezar|reiniciar|empezar otra vez)[.!¡]*$/i.test(text)
  ) {
    await save("name", {});
    return { outbound: [es.signupAskName(profile)], step: "name" };
  }
  // Registro viejo parado en cuentas: un texto, «ayuda» o una nota de voz pasan al presupuesto, sin
  // volver a mostrar la pregunta de cuentas (N2). Los botones de cuentas siguen abajo.
  if ((step === "accounts" || step === "accounts_confirm") && !choice?.startsWith("acc:")) {
    await save("budget", { ...data, accounts: [], pendingAccounts: undefined });
    return {
      outbound: [
        es.signupWelcomeBack(data.name ?? null, remainingSteps("budget", data)),
        prompt("budget", data, profile),
      ],
      step,
    };
  }
  if (!text && !choice) {
    await save(step);
    return { outbound: [es.signupTextOnly(), prompt(step, data, profile)], step };
  }
  // Volvió después de 6 h o más con un texto: dónde quedamos, sin leer ese texto como respuesta (un
  // «hola» no es una categoría). Un botón del paso actual se procesa normal aunque pasen días.
  const away = now.getTime() - row.updatedAt.getTime() >= WELCOME_BACK_MS;
  if (text && away && WELCOME_BACK_STEPS.includes(step)) {
    await save(step);
    return {
      outbound: [
        es.signupWelcomeBack(data.name ?? null, remainingSteps(step, data)),
        prompt(step, data, profile),
      ],
      step,
    };
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
      // «sí», «dale», «esas»… es aceptar las sugeridas; un saludo o «saltar» repite la pregunta
      // (antes «hola» quedaba como categoría).
      if (choice === "cat:ok" || (text && YES.test(intentOf(text))))
        categories = onboardingCategories(undefined, type);
      else if (
        text &&
        !GREETING.test(intentOf(text)) &&
        !/^(hola+|buen[oa]s?)\b/.test(intentOf(text)) &&
        !SKIP.test(intentOf(text))
      )
        categories = parseCategoryList(text, type);
      if (!categories) {
        await save("categories");
        return { outbound: [prompt("categories", data, profile)], step };
      }
      await save("budget", { ...data, categories, accounts: [] });
      return {
        outbound: [es.signupCategoriesSet(categories), prompt("budget", data, profile)],
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
      // Registro viejo parado en cuentas: cualquier texto pasa al presupuesto, sin leerlo como
      // cuentas (antes «hola» creaba la cuenta "Hola").
      await save("budget", { ...data, accounts: [], pendingAccounts: undefined });
      return {
        outbound: [
          es.signupWelcomeBack(data.name ?? null, remainingSteps("budget", data)),
          prompt("budget", data, profile),
        ],
        step,
      };
    }
    case "budget": {
      let budgets: { category: string; amountUsd: string }[] = [];
      if (choice !== "bud:skip" && !(text && SKIP.test(intentOf(text)))) {
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
            es.signupDone({
              ...doneView(final),
              founderUntil: created.founderUntil,
              trialMessages: TRIAL_MESSAGES,
            }),
            es.signupTour(
              cfg.dashboardUrl,
              final.kind ?? "personal",
              Boolean(final.accounts?.length),
            ),
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

function doneView(d: SignupData): Omit<Parameters<typeof es.signupDone>[0], "founderUntil"> {
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
      return es.signupAskBusinessName(progressOf("biz_name", data));
    case "biz_type":
      return es.signupAskBusinessType(
        data.businessName ?? "tu negocio",
        progressOf("biz_type", data),
      );
    case "currency":
      return es.signupAskCurrency(data.kind === "business", progressOf("currency", data));
    case "categories":
      return es.signupAskCategories(
        onboardingCategories(undefined, data.businessType ?? "personal"),
        data.kind === "business",
        progressOf("categories", data),
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

/** Preguntas del registro, en orden, según sea personal o negocio (el presupuesto va aparte). */
function questionsFor(data: SignupData): SignupStep[] {
  return data.kind === "business"
    ? ["name", "kind", "biz_name", "biz_type", "currency", "categories"]
    : ["name", "kind", "currency", "categories"];
}

/** «*3 de 6* · » desde la tercera pregunta; nada en el nombre ni en personal/negocio. */
function progressOf(step: SignupStep, data: SignupData): es.SignupProgress {
  const qs = questionsFor(data);
  const i = qs.indexOf(step);
  return i >= 2 ? { n: i + 1, total: qs.length } : null;
}

/** Pasos que faltan, contando el actual, más uno por el presupuesto. En el presupuesto, 1. */
export function remainingSteps(step: SignupStep, data: SignupData): number {
  const qs = questionsFor(data);
  const i = qs.indexOf(step);
  return i < 0 ? 1 : qs.length - i + 1;
}

/** Mensaje de regreso: después de 6 h, en los pasos donde ya se sabe si es personal o negocio. */
const WELCOME_BACK_MS = 6 * 60 * 60_000;
const WELCOME_BACK_STEPS: SignupStep[] = [
  "biz_name",
  "biz_type",
  "currency",
  "categories",
  "budget",
];

/** Para comparar intenciones: sin tildes, en minúsculas y sin puntuación al final. */
function intentOf(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.!?¡¿,;:]+$/g, "")
    .replace(/^[¡¿]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Palabras que son intención, no datos (auditoría del 26/10, F2a). */
const YES =
  /^(si|sip|ok|okey|dale|listo|perfecto|correcto|esta bien|asi esta bien|me sirven?|sirven|esas|usar estas)$/;
const SKIP = /^(saltar|no|nop|ningun[oa]?|no tengo|despues|luego|ahora no|paso|omitir|no gracias)$/;

/** Lo que alguien escribe en vez de su nombre al llegar. */
const NOT_A_NAME = /^(quiero probar|como funciona|info|informacion|hola rocco|rocco)$/;

// ---------------------------------------------------------------- lectores de respuestas

/** Nombre de perfil de WhatsApp usable: el primer nombre, con letras, de 2 a 14 caracteres. */
export function cleanProfileName(raw: string | null): string | null {
  const first = raw?.trim().split(/\s+/)[0] ?? "";
  if (!/^\p{L}[\p{L}'-]{1,13}$/u.test(first)) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

const GREETING =
  /^(hola+|buen[oa]s?( noches| tardes| d[ií]as)?|hey|epa|saludos|ok|okey|s[ií]|no|listo|dale)[!.\s]*$/i;

/** "Me llamo Javier Ortiz" → "Javier Ortiz". Null si parece un saludo o no es un nombre. */
export function parsePersonName(text: string): string | null {
  const t = text
    .trim()
    .replace(/^(hola[,!.]?\s*)?(me llamo|mi nombre es|soy|ll[aá]mame|dime)\s+/i, "")
    .replace(/[.!¡]+$/g, "")
    .trim();
  const intent = intentOf(t);
  if (!t || GREETING.test(t) || t.length > 40 || /\d/.test(t)) return null;
  if (NOT_A_NAME.test(intent) || YES.test(intent) || SKIP.test(intent)) return null;
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
/** Seguridad F3: los códigos del panel tienen 8 dígitos (los de vincular un número, 6). */
export const LINK_CODE_RE = /^\s*(\d{8})\s*$/;
/** Seguridad F3: máximo de códigos del panel por usuario en una hora. */
export const LINK_CODES_PER_HOUR = 5;
/** Tiempo para tocar «Sí, darle acceso» después de mandar el código. */
export const LINK_CONFIRM_MS = 10 * 60_000;
const linkHash = (code: string) =>
  createHash("sha256").update(`dashboard-link:${code}`).digest("hex");

export class LinkRateError extends Error {
  constructor() {
    super("demasiados códigos del panel en una hora");
    this.name = "LinkRateError";
  }
}

/** j***@gmail.com: lo que Rocco muestra de un correo por WhatsApp. */
export function maskEmail(email: string): string {
  const [user = "", domain = ""] = email.split("@");
  return domain ? `${user.slice(0, 1)}***@${domain}` : "***";
}

/**
 * El usuario del panel (ya con correo verificado) pide conectar un negocio creado por WhatsApp:
 * recibe un código de 8 dígitos que manda a Rocco desde su número. Vence los anteriores del mismo
 * usuario. Máximo 5 por hora (F3).
 */
export async function createDashboardLink(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<{ code: string; expiresAt: Date }> {
  const l = schema.dashboardLink;
  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(l)
    .where(and(eq(l.userId, userId), gt(l.createdAt, new Date(now.getTime() - 3_600_000))));
  if ((recent?.n ?? 0) >= LINK_CODES_PER_HOUR) throw new LinkRateError();
  await db
    .update(l)
    .set({ expiresAt: now })
    .where(and(eq(l.userId, userId), isNull(l.usedAt), gt(l.expiresAt, now)));
  const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS);
  await db.insert(l).values({ userId, codeHash: linkHash(code), expiresAt, createdAt: now });
  return { code, expiresAt };
}

export type LinkClaim = {
  linkId: string;
  email: string;
  /** Correos (enmascarados) que ya tienen acceso a este panel. */
  existing: string[];
};

/**
 * El dueño mandó por WhatsApp un código del panel (F3): todavía no da acceso. El enlace queda
 * apartado para este negocio 10 minutos, hasta que el dueño toque «Sí, darle acceso». null si el
 * código no es de un enlace vigente sin usar.
 */
export async function claimDashboardLink(
  tx: Tx,
  ref: { tenantId: string; phoneId: string },
  code: string,
  now: Date = new Date(),
): Promise<LinkClaim | null> {
  const l = schema.dashboardLink;
  const [open] = await tx
    .select()
    .from(l)
    .where(
      and(
        eq(l.codeHash, linkHash(code)),
        isNull(l.usedAt),
        isNull(l.tenantId),
        gt(l.expiresAt, now),
      ),
    )
    .limit(1);
  if (!open) return null;
  const until = new Date(Math.min(open.expiresAt.getTime(), now.getTime() + LINK_CONFIRM_MS));
  await tx.update(l).set({ tenantId: ref.tenantId, expiresAt: until }).where(eq(l.id, open.id));
  const [u] = await tx
    .select({ email: schema.userAccount.email })
    .from(schema.userAccount)
    .where(eq(schema.userAccount.id, open.userId));
  const members = await dashboardMembers(tx, ref.tenantId);
  return {
    linkId: open.id,
    email: maskEmail(u?.email ?? ""),
    existing: members.filter((m) => m.userId !== open.userId).map((m) => maskEmail(m.email)),
  };
}

/**
 * «Sí, darle acceso» / «No» (F3). Con «Sí», el usuario del panel queda como dueño de este negocio;
 * con «No», el código ya no sirve. "expired" si pasaron los 10 minutos o ya se usó.
 */
export async function confirmDashboardLink(
  tx: Tx,
  ref: { tenantId: string; phoneId: string },
  linkId: string,
  yes: boolean,
  now: Date = new Date(),
): Promise<{ email: string } | "declined" | "expired"> {
  const l = schema.dashboardLink;
  const [open] = await tx
    .select()
    .from(l)
    .where(
      and(eq(l.id, linkId), eq(l.tenantId, ref.tenantId), isNull(l.usedAt), gt(l.expiresAt, now)),
    )
    .limit(1);
  if (!open) return "expired";
  await tx.update(l).set({ usedAt: now }).where(eq(l.id, open.id));
  if (!yes) return "declined";
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

export type DashboardMember = { userId: string; email: string; role: string };

/** Quién tiene acceso al panel de este negocio (Ajustes → Acceso al panel, F3). */
export async function dashboardMembers(tx: Tx, tenantId: string): Promise<DashboardMember[]> {
  return tx
    .select({
      userId: schema.tenantMember.userId,
      email: schema.userAccount.email,
      role: schema.tenantMember.role,
    })
    .from(schema.tenantMember)
    .innerJoin(schema.userAccount, eq(schema.userAccount.id, schema.tenantMember.userId))
    .where(eq(schema.tenantMember.tenantId, tenantId))
    .orderBy(schema.userAccount.email);
}

/** «Quitar acceso» (F3): solo el dueño, nunca a sí mismo. false si no había nada que quitar. */
export async function removeDashboardMember(
  tx: Tx,
  ref: { tenantId: string; actorUserId: string },
  userId: string,
): Promise<boolean> {
  if (userId === ref.actorUserId) return false;
  const m = schema.tenantMember;
  const gone = await tx
    .delete(m)
    .where(and(eq(m.tenantId, ref.tenantId), eq(m.userId, userId)))
    .returning({ role: m.role });
  if (!gone.length) return false;
  await tx.insert(schema.auditLog).values({
    tenantId: ref.tenantId,
    actorType: "user",
    actorId: ref.actorUserId,
    action: "delete",
    entity: "tenant_member",
    entityId: userId,
    before: { userId, role: gone[0]?.role },
    after: null,
    channel: "dashboard",
  });
  return true;
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

// ---------------------------------------------------------------- prueba del «hola» (26/10)

export type ParkedStep = "accounts" | "categories";

/**
 * Deja un número de prueba con el registro a medias, para la prueba del «hola» del handoff del
 * 26/10: en `accounts` como lo dejaba el flujo viejo (ya con categorías) o en `categories`.
 * `hoursAgo` mueve `updated_at` atrás (7 h por defecto) para que el mensaje de regreso salga al
 * primer texto. Nunca toca un número que ya tiene negocio: ese mensaje iría al agente.
 */
export async function parkSignup(
  db: Db,
  opts: {
    e164: string;
    step: ParkedStep;
    kind?: "personal" | "business";
    hoursAgo?: number;
  },
  now: Date = new Date(),
): Promise<{ e164: string; step: ParkedStep; data: SignupData; updatedAt: Date }> {
  const e164 = opts.e164.replace(/\D/g, "");
  if (!/^\d{10,15}$/.test(e164)) throw new Error(`número inválido: ${opts.e164}`);
  const [phone] = await db
    .select({ id: schema.phoneNumber.id })
    .from(schema.phoneNumber)
    .where(eq(schema.phoneNumber.e164, e164));
  if (phone) throw new Error(`${e164} ya tiene un negocio; usa un número sin cuenta`);
  // Nunca pisa un registro real a medias (K1): solo uno vacío o uno que ya era de prueba.
  const [existing] = await db
    .select({ data: schema.signup.data })
    .from(schema.signup)
    .where(eq(schema.signup.e164, e164));
  if (existing && (existing.data as SignupData | null)?.name !== "Prueba")
    throw new Error(`${e164} tiene un registro real; usa un número interno`);

  const kind = opts.kind ?? "personal";
  const businessType: BusinessType = kind === "business" ? "food" : "personal";
  const data: SignupData = {
    name: "Prueba",
    kind,
    businessType,
    ...(kind === "business" ? { businessName: "Negocio de prueba" } : {}),
    currency: "USD",
    ...(opts.step === "accounts"
      ? { categories: onboardingCategories(undefined, businessType) }
      : {}),
  };
  const updatedAt = new Date(now.getTime() - (opts.hoursAgo ?? 7) * 3_600_000);
  const s = schema.signup;
  await db
    .insert(s)
    .values({ e164, step: opts.step, data, messages: 4, updatedAt })
    .onConflictDoUpdate({
      target: s.e164,
      set: { step: opts.step, data, messages: 4, completedAt: null, tenantId: null, updatedAt },
    });
  return { e164, step: opts.step, data, updatedAt };
}
