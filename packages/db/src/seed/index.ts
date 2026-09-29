import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createDb, withTenant } from "../client.js";
import { category, phoneNumber, tenant } from "../schema/index.js";
import { DEFAULT_EXPENSE_CATEGORIES } from "./default-categories.js";

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

async function main() {
  const env = Env.parse(process.env);
  const { db, close } = createDb(env.DATABASE_URL, { max: 1 });
  try {
    const taken = await db.execute<{ taken: boolean }>(
      sql`select app.phone_is_taken(${env.SEED_OWNER_PHONE}) as taken`,
    );
    if (taken[0]?.taken) {
      console.log("seed ya aplicado (número del dueño existe)");
      return;
    }
    const first = await seedTenant(db, {
      name: "Autolavado (piloto 1)",
      businessType: "car_wash",
      ownerPhone: env.SEED_OWNER_PHONE,
    });
    console.log(`tenant 1 creado: ${first}`);
    if (env.SEED_SECOND_TENANT_PHONE) {
      const second = await seedTenant(db, {
        name: "Cinnamon rolls (piloto 2)",
        businessType: "food",
        ownerPhone: env.SEED_SECOND_TENANT_PHONE,
      });
      console.log(`tenant 2 creado: ${second}`);
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
