import { createHash, randomInt } from "node:crypto";
import {
  and,
  type Db,
  desc,
  eq,
  gt,
  isNull,
  type Queryable,
  rows,
  schema,
  sql,
  type Tx,
  withTenant,
} from "@caja/db";
import {
  DEFAULT_EXPENSE_CATEGORIES,
  MAX_ACTIVE_CATEGORIES,
  MAX_CATEGORY_NAME_LENGTH,
  OTHERS_CATEGORY,
} from "@caja/db/seed-data";
import type { PlanId } from "../billing/plans";
import { businessDateOf } from "../domain/dates";
import { Decimal } from "../domain/money";
import { type AccountKind, createAccount } from "../ledger/accounts";

/**
 * Onboarding (US-A1, US-A2, US-A4). El dueño crea el negocio en el dashboard y prueba que el
 * número es suyo enviando un código de 6 dígitos por WhatsApp. El código vive 15 minutos, admite
 * 3 intentos y solo se guarda su hash. El empleado no necesita código: el dueño lo autoriza.
 */
export const CODE_TTL_MS = 15 * 60_000;
export const CODE_MAX_ATTEMPTS = 3;
export const CODE_RE = /^\s*(\d{6})\s*$/;

export type BusinessType = (typeof schema.BUSINESS_TYPES)[number];
export const BUSINESS_TYPE_LABELS: Record<BusinessType, string> = {
  car_wash: "Autolavado",
  food: "Comida y bebidas",
  retail: "Tienda o bodega",
  services: "Servicios",
  other: "Otro",
  personal: "Personal",
};

export class PhoneTakenError extends Error {
  constructor(public readonly e164: string) {
    super("ese número ya pertenece a otro negocio");
    this.name = "PhoneTakenError";
  }
}

export type RegisterInput = {
  /** auth.users.id ya reclamado en user_account (lo hace la sesión del dashboard). */
  userId: string;
  name: string;
  businessType: BusinessType;
  defaultExpenseCurrency: "USD" | "VES";
  /** E.164 sin '+'. */
  ownerPhone: string;
  ownerName?: string | null;
  /** Plan elegido en el onboarding (05/10); por defecto, Personal para el tipo personal y Negocio. */
  plan?: PlanId;
  /** Categorías de gasto elegidas; sin esto, las del tipo. "Otros" siempre queda. */
  categories?: string[];
  /** Cuentas iniciales (banco, Binance, efectivo…), con lo que hay hoy en cada una. */
  accounts?: {
    name: string;
    currency: "USD" | "VES";
    kind: AccountKind;
    openingBalance: string;
  }[];
};

/** Hasta 3 cuentas en el onboarding; las demás desde Ajustes → Cuentas. */
export const ONBOARDING_MAX_ACCOUNTS = 3;

/**
 * Lista de categorías elegida en el onboarding: sin repetidas (sin importar mayúsculas ni
 * acentos), nombres cortos, "Otros" al final, máximo 10 (lo que cabe en una lista de WhatsApp).
 */
export function onboardingCategories(
  chosen: string[] | undefined,
  businessType: BusinessType,
): string[] {
  const norm = (n: string) => n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const base = chosen ?? DEFAULT_EXPENSE_CATEGORIES[businessType] ?? [];
  const seen = new Set<string>([norm(OTHERS_CATEGORY)]);
  const out: string[] = [];
  for (const raw of base) {
    const name = raw.replace(/\s+/g, " ").trim().slice(0, MAX_CATEGORY_NAME_LENGTH);
    if (!name || seen.has(norm(name))) continue;
    seen.add(norm(name));
    out.push(name);
    if (out.length >= MAX_ACTIVE_CATEGORIES - 1) break;
  }
  return [...out, OTHERS_CATEGORY];
}

export type IssuedCode = { code: string; expiresAt: Date };

export async function phoneIsTaken(db: Queryable, e164: string): Promise<boolean> {
  const [r] = rows<{ taken: boolean }>(
    await db.execute(sql`select app.phone_is_taken(${e164}) as taken`),
  );
  return r?.taken === true;
}

/**
 * Crea el negocio con sus categorías por defecto, el número del dueño en `pending`, la membresía
 * del dashboard y el primer código. Un número pertenece a un solo negocio en toda la plataforma.
 */
export async function registerBusiness(
  db: Db,
  input: RegisterInput,
  now: Date = new Date(),
): Promise<{ tenantId: string; phoneId: string } & IssuedCode> {
  if (await phoneIsTaken(db, input.ownerPhone)) throw new PhoneTakenError(input.ownerPhone);
  const tenantId = crypto.randomUUID();
  return withTenant(db, tenantId, async (tx) => {
    await tx.insert(schema.tenant).values({
      id: tenantId,
      name: input.name.trim(),
      businessType: input.businessType,
      defaultExpenseCurrency: input.defaultExpenseCurrency,
      status: "trial",
      plan: input.plan ?? (input.businessType === "personal" ? "personal" : "negocio"),
    });
    const names = onboardingCategories(input.categories, input.businessType);
    if (names.length)
      await tx
        .insert(schema.category)
        .values(names.map((name, i) => ({ tenantId, name, kind: "expense", sortOrder: i })));
    await tx
      .insert(schema.tenantMember)
      .values({ tenantId, userId: input.userId, role: "owner" })
      .onConflictDoNothing();
    const [phone] = await tx
      .insert(schema.phoneNumber)
      .values({
        tenantId,
        e164: input.ownerPhone,
        role: "owner",
        status: "pending",
        displayName: input.ownerName?.trim() || null,
      })
      .returning({ id: schema.phoneNumber.id });
    if (!phone) throw new Error("no se pudo crear el número del dueño");
    await tx.insert(schema.auditLog).values({
      tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "create",
      entity: "tenant",
      entityId: tenantId,
      before: null,
      after: { name: input.name.trim(), businessType: input.businessType },
      channel: "dashboard",
    });
    for (const a of (input.accounts ?? []).slice(0, ONBOARDING_MAX_ACCOUNTS)) {
      const opening = new Decimal(a.openingBalance || "0");
      await createAccount(tx, {
        tenantId,
        name: a.name,
        currency: a.currency,
        kind: a.kind,
        openingBalance: opening.isFinite() ? opening : new Decimal(0),
        openingDate: businessDateOf(now),
        actor: { userId: input.userId },
        channel: "dashboard",
      });
    }
    const issued = await issueCode(tx, { tenantId, phoneId: phone.id }, now);
    return { tenantId, phoneId: phone.id, ...issued };
  });
}

function hashCode(phoneId: string, code: string): string {
  return createHash("sha256").update(`${phoneId}:${code}`).digest("hex");
}

/** Genera un código nuevo y vence los anteriores del mismo número. Devuelve el código en claro. */
export async function issueCode(
  tx: Tx,
  ref: { tenantId: string; phoneId: string },
  now: Date = new Date(),
): Promise<IssuedCode> {
  const v = schema.phoneVerification;
  await tx
    .update(v)
    .set({ expiresAt: now })
    .where(and(eq(v.phoneId, ref.phoneId), isNull(v.usedAt), gt(v.expiresAt, now)));
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  await tx.insert(v).values({
    tenantId: ref.tenantId,
    phoneId: ref.phoneId,
    codeHash: hashCode(ref.phoneId, code),
    expiresAt,
  });
  return { code, expiresAt };
}

export type VerifyOutcome = "ok" | "mismatch" | "expired";

/**
 * Comprueba el código que llegó por WhatsApp contra el último vigente del número. Si coincide,
 * activa el número; si no, suma un intento; al tercer fallo el código deja de servir.
 */
export async function verifyCode(
  tx: Tx,
  ref: { tenantId: string; phoneId: string; waUserId: string | null; displayName: string | null },
  code: string,
  now: Date = new Date(),
): Promise<VerifyOutcome> {
  const v = schema.phoneVerification;
  const [open] = await tx
    .select()
    .from(v)
    .where(and(eq(v.phoneId, ref.phoneId), isNull(v.usedAt), gt(v.expiresAt, now)))
    .orderBy(desc(v.createdAt))
    .limit(1);
  if (!open || open.attempts >= CODE_MAX_ATTEMPTS) return "expired";
  if (open.codeHash !== hashCode(ref.phoneId, code)) {
    const attempts = open.attempts + 1;
    await tx
      .update(v)
      .set(attempts >= CODE_MAX_ATTEMPTS ? { attempts, expiresAt: now } : { attempts })
      .where(eq(v.id, open.id));
    return attempts >= CODE_MAX_ATTEMPTS ? "expired" : "mismatch";
  }
  await tx.update(v).set({ usedAt: now }).where(eq(v.id, open.id));
  await activatePhone(tx, ref, now);
  return "ok";
}

/** Marca el número como verificado y guarda el identificador de WhatsApp si llegó. */
export async function activatePhone(
  tx: Tx,
  ref: { tenantId: string; phoneId: string; waUserId: string | null; displayName: string | null },
  now: Date,
): Promise<void> {
  const p = schema.phoneNumber;
  const [before] = await tx.select().from(p).where(eq(p.id, ref.phoneId));
  const [after] = await tx
    .update(p)
    .set({
      status: "active",
      verifiedAt: now,
      waUserId: ref.waUserId ?? before?.waUserId ?? null,
      displayName: before?.displayName ?? ref.displayName ?? null,
    })
    .where(eq(p.id, ref.phoneId))
    .returning();
  await tx.insert(schema.auditLog).values({
    tenantId: ref.tenantId,
    actorType: "phone",
    actorId: ref.phoneId,
    action: "verify",
    entity: "phone_number",
    entityId: ref.phoneId,
    before: before ? { status: before.status, verifiedAt: before.verifiedAt } : null,
    after: after ? { status: after.status, verifiedAt: after.verifiedAt } : null,
    channel: "whatsapp",
  });
}

export type TenantPhone = {
  id: string;
  e164: string;
  role: "owner" | "employee";
  status: "pending" | "active" | "disabled";
  displayName: string | null;
  verifiedAt: Date | null;
};

export async function tenantPhones(tx: Tx, tenantId: string): Promise<TenantPhone[]> {
  const p = schema.phoneNumber;
  const list = await tx
    .select({
      id: p.id,
      e164: p.e164,
      role: p.role,
      status: p.status,
      displayName: p.displayName,
      verifiedAt: p.verifiedAt,
    })
    .from(p)
    .where(eq(p.tenantId, tenantId))
    .orderBy(sql`case when ${p.role} = 'owner' then 0 else 1 end`, p.createdAt);
  return list as TenantPhone[];
}

/** El número del dueño y su estado, para la pantalla de vinculación y el aviso en Inicio. */
export async function ownerPhone(db: Db, tenantId: string): Promise<TenantPhone | null> {
  return withTenant(db, tenantId, async (tx) => {
    const list = await tenantPhones(tx, tenantId);
    return list.find((p) => p.role === "owner") ?? null;
  });
}

/**
 * Alta de un empleado desde el dashboard (US-A4). Queda `active` sin `verified_at`: al primer
 * mensaje recibe la bienvenida. Si el número ya estaba en este negocio, se reactiva.
 */
export async function addEmployee(
  db: Db,
  ref: { tenantId: string; userId: string },
  input: { e164: string; displayName: string | null },
  now: Date = new Date(),
): Promise<{ phoneId: string; created: boolean }> {
  return withTenant(db, ref.tenantId, async (tx) => {
    const p = schema.phoneNumber;
    const [own] = await tx
      .select()
      .from(p)
      .where(and(eq(p.tenantId, ref.tenantId), eq(p.e164, input.e164)));
    if (!own && (await phoneIsTaken(tx, input.e164))) throw new PhoneTakenError(input.e164);
    if (own) {
      if (own.role === "owner") throw new PhoneTakenError(input.e164);
      await tx
        .update(p)
        .set({ status: "active", displayName: input.displayName ?? own.displayName })
        .where(eq(p.id, own.id));
      await audit(tx, ref, own.id, "update", { status: own.status }, { status: "active" }, now);
      return { phoneId: own.id, created: false };
    }
    const [row] = await tx
      .insert(p)
      .values({
        tenantId: ref.tenantId,
        e164: input.e164,
        role: "employee",
        status: "active",
        displayName: input.displayName,
      })
      .returning({ id: p.id });
    if (!row) throw new Error("no se pudo crear el número");
    await audit(tx, ref, row.id, "create", null, { e164: input.e164, role: "employee" }, now);
    return { phoneId: row.id, created: true };
  });
}

/** Desactivar o reactivar un número. El del dueño no se toca desde aquí. */
export async function setPhoneStatus(
  db: Db,
  ref: { tenantId: string; userId: string },
  phoneId: string,
  status: "active" | "disabled",
  now: Date = new Date(),
): Promise<boolean> {
  return withTenant(db, ref.tenantId, async (tx) => {
    const p = schema.phoneNumber;
    const [own] = await tx
      .select()
      .from(p)
      .where(and(eq(p.tenantId, ref.tenantId), eq(p.id, phoneId)));
    if (!own || own.role === "owner" || own.status === status) return false;
    await tx.update(p).set({ status }).where(eq(p.id, phoneId));
    await audit(tx, ref, phoneId, "update", { status: own.status }, { status }, now);
    return true;
  });
}

async function audit(
  tx: Tx,
  ref: { tenantId: string; userId: string },
  phoneId: string,
  action: "create" | "update",
  before: unknown,
  after: unknown,
  _now: Date,
) {
  await tx.insert(schema.auditLog).values({
    tenantId: ref.tenantId,
    actorType: "user",
    actorId: ref.userId,
    action,
    entity: "phone_number",
    entityId: phoneId,
    before,
    after,
    channel: "dashboard",
  });
}

export type ChatRegisterInput = {
  /** E.164 sin '+': el número que le escribió a Rocco. WhatsApp ya probó que es suyo. */
  e164: string;
  waUserId: string | null;
  /** Nombre de la persona (dueño o usuario personal). */
  ownerName: string;
  /** Nombre del negocio; en el tipo personal, el de la persona. */
  name: string;
  businessType: BusinessType;
  defaultExpenseCurrency: "USD" | "VES";
  categories?: string[] | undefined;
  accounts?:
    | {
        name: string;
        currency: "USD" | "VES";
        kind: AccountKind;
        openingBalance: string;
      }[]
    | undefined;
  /** Topes mensuales en dólares por nombre de categoría (de las elegidas). */
  budgets?: { category: string; amountUsd: string }[] | undefined;
};

/** Hasta 5 cuentas en el registro por chat; las demás con "crea la cuenta…" o en el panel. */
export const CHAT_SIGNUP_MAX_ACCOUNTS = 5;

/**
 * Registro por WhatsApp (0018): el mismo negocio que crea el asistente web, pero sin usuario del
 * panel (se conecta después con `dashboard_link`) y con el número ya activo: escribirle a Rocco
 * prueba que es suyo. Cuentas y presupuestos que fallen no tumban el registro.
 */
export async function registerFromChat(
  db: Db,
  input: ChatRegisterInput,
  now: Date = new Date(),
): Promise<{ tenantId: string; phoneId: string }> {
  if (await phoneIsTaken(db, input.e164)) throw new PhoneTakenError(input.e164);
  const tenantId = crypto.randomUUID();
  return withTenant(db, tenantId, async (tx) => {
    await tx.insert(schema.tenant).values({
      id: tenantId,
      name: input.name.trim(),
      businessType: input.businessType,
      defaultExpenseCurrency: input.defaultExpenseCurrency,
      status: "trial",
      plan: input.businessType === "personal" ? "personal" : "negocio",
      signupChannel: "whatsapp",
    });
    const names = onboardingCategories(input.categories, input.businessType);
    const cats = names.length
      ? await tx
          .insert(schema.category)
          .values(names.map((name, i) => ({ tenantId, name, kind: "expense", sortOrder: i })))
          .returning({ id: schema.category.id, name: schema.category.name })
      : [];
    const [phone] = await tx
      .insert(schema.phoneNumber)
      .values({
        tenantId,
        e164: input.e164,
        role: "owner",
        status: "active",
        verifiedAt: now,
        waUserId: input.waUserId,
        displayName: input.ownerName.trim() || null,
      })
      .returning({ id: schema.phoneNumber.id });
    if (!phone) throw new Error("no se pudo crear el número del dueño");
    await tx.insert(schema.auditLog).values({
      tenantId,
      actorType: "phone",
      actorId: phone.id,
      action: "create",
      entity: "tenant",
      entityId: tenantId,
      before: null,
      after: { name: input.name.trim(), businessType: input.businessType },
      channel: "whatsapp",
    });
    for (const a of (input.accounts ?? []).slice(0, CHAT_SIGNUP_MAX_ACCOUNTS)) {
      const opening = new Decimal(a.openingBalance || "0");
      try {
        // Punto de guardado: si la cuenta falla (tasa, repetida), el registro sigue.
        await tx.transaction((sp) =>
          createAccount(sp, {
            tenantId,
            name: a.name,
            currency: a.currency,
            kind: a.kind,
            openingBalance: opening.isFinite() ? opening : new Decimal(0),
            openingDate: businessDateOf(now),
            actor: { phoneId: phone.id },
            channel: "whatsapp",
          }),
        );
      } catch {
        // Repetida o inválida: se omite; la puede crear después por chat.
      }
    }
    const byName = new Map(cats.map((c) => [plainName(c.name), c.id]));
    for (const b of input.budgets ?? []) {
      const categoryId = byName.get(plainName(b.category));
      const amount = new Decimal(b.amountUsd || "0");
      if (!categoryId || !amount.isFinite() || amount.lte(0)) continue;
      const next = { period: "monthly", amountUsd: amount.toFixed(2) };
      const [row] = await tx
        .insert(schema.budget)
        .values({ tenantId, categoryId, ...next })
        .onConflictDoNothing()
        .returning({ id: schema.budget.id });
      if (row)
        await tx.insert(schema.auditLog).values({
          tenantId,
          actorType: "phone",
          actorId: phone.id,
          action: "create",
          entity: "budget",
          entityId: row.id,
          before: null,
          after: next,
          channel: "whatsapp",
        });
    }
    return { tenantId, phoneId: phone.id };
  });
}

/** Nombre sin mayúsculas ni acentos, para comparar categorías. */
export function plainName(n: string): string {
  return n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}
