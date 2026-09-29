import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createDb, rows, withTenant } from "../client";
import { loadNearestEnvFile } from "../env-file";
import { category, phoneNumber, tenant, tenantMember, userAccount } from "../schema/index";
import { DEFAULT_EXPENSE_CATEGORIES } from "./default-categories";

/**
 * Seed del piloto: dos negocios, cada uno con su dueño. Idempotente por número de teléfono.
 * Corre con el rol de aplicación: crea el tenant fijando `app.tenant_id` al id generado, que
 * es exactamente lo que hace el onboarding real.
 */
const Env = z.object({
  DATABASE_URL: z.string().min(1),
  SEED_OWNER_PHONE: z.string().regex(/^\d{8,15}$/),
  SEED_OWNER_EMAIL: z.string().email().optional(),
  SEED_SECOND_TENANT_PHONE: z
    .string()
    .regex(/^\d{8,15}$/)
    .optional(),
  SEED_SECOND_TENANT_EMAIL: z.string().email().optional(),
});

export async function seedTenant(
  db: ReturnType<typeof createDb>["db"],
  input: { name: string; businessType: string; ownerPhone: string; ownerName?: string },
) {
  const id = randomUUID();
  return withTenant(db, id, async (tx) => {
    await tx.insert(tenant).values({
      id,
      name: input.name,
      businessType: input.businessType,
      defaultExpenseCurrency: "USD",
      status: "trial",
    });
    const names =
      DEFAULT_EXPENSE_CATEGORIES[input.businessType] ?? DEFAULT_EXPENSE_CATEGORIES.other ?? [];
    await tx
      .insert(category)
      .values(names.map((name, i) => ({ tenantId: id, name, kind: "expense", sortOrder: i })));
    await tx.insert(phoneNumber).values({
      tenantId: id,
      e164: input.ownerPhone,
      role: "owner",
      status: "active",
      displayName: input.ownerName ?? null,
      verifiedAt: new Date(),
    });
    return id;
  });
}

/**
 * Deja al dueño con acceso al dashboard: `user_account` por correo (id provisional hasta el
 * primer login, cuando `app.claim_account` lo reemplaza por el de Supabase Auth) y membresía
 * `owner`. Idempotente.
 */
export async function ensureOwnerAccount(
  db: ReturnType<typeof createDb>["db"],
  tenantId: string,
  email: string,
): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const [existing] = await db
    .select({ id: userAccount.id })
    .from(userAccount)
    .where(sql`lower(${userAccount.email}) = ${normalized}`);
  const userId = existing?.id ?? randomUUID();
  if (!existing) await db.insert(userAccount).values({ id: userId, email: normalized });
  await withTenant(db, tenantId, (tx) =>
    tx.insert(tenantMember).values({ tenantId, userId, role: "owner" }).onConflictDoNothing(),
  );
}

/** Tenant de un teléfono ya sembrado, vía la función de enrutamiento (sin fijar tenant). */
async function tenantOfPhone(db: ReturnType<typeof createDb>["db"], e164: string) {
  const [row] = rows<{ tenant_id: string }>(
    await db.execute(sql`select tenant_id from app.resolve_phone(${e164}, null)`),
  );
  return row?.tenant_id ?? null;
}

async function main() {
  loadNearestEnvFile();
  const env = Env.parse(process.env);
  const { db, close } = createDb(env.DATABASE_URL, { max: 1 });
  try {
    const taken = rows<{ taken: boolean }>(
      await db.execute(sql`select app.phone_is_taken(${env.SEED_OWNER_PHONE}) as taken`),
    );
    let first: string | null;
    let second: string | null = null;
    if (taken[0]?.taken) {
      console.log("seed ya aplicado (número del dueño existe); solo se revisan los accesos");
      first = await tenantOfPhone(db, env.SEED_OWNER_PHONE);
      if (env.SEED_SECOND_TENANT_PHONE)
        second = await tenantOfPhone(db, env.SEED_SECOND_TENANT_PHONE);
    } else {
      first = await seedTenant(db, {
        name: "Autolavado (piloto 1)",
        businessType: "car_wash",
        ownerPhone: env.SEED_OWNER_PHONE,
      });
      console.log(`tenant 1 creado: ${first}`);
      if (env.SEED_SECOND_TENANT_PHONE) {
        second = await seedTenant(db, {
          name: "Cinnamon rolls (piloto 2)",
          businessType: "food",
          ownerPhone: env.SEED_SECOND_TENANT_PHONE,
        });
        console.log(`tenant 2 creado: ${second}`);
      }
    }
    if (first && env.SEED_OWNER_EMAIL) {
      await ensureOwnerAccount(db, first, env.SEED_OWNER_EMAIL);
      console.log(`acceso al dashboard: ${env.SEED_OWNER_EMAIL} → tenant 1`);
    }
    if (second && env.SEED_SECOND_TENANT_EMAIL) {
      await ensureOwnerAccount(db, second, env.SEED_SECOND_TENANT_EMAIL);
      console.log(`acceso al dashboard: ${env.SEED_SECOND_TENANT_EMAIL} → tenant 2`);
    }
  } finally {
    await close();
  }
}

const isMain =
  process.argv[1]?.endsWith("seed/index.ts") || process.argv[1]?.endsWith("seed/index.js");
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
