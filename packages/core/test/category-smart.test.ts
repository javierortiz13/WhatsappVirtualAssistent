import { and, eq, schema, sql, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultCategoryId } from "../src/agent/tools";
import { asIsoDate } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";
import {
  categoryExamples,
  ensureIncomeCategories,
  ensureOtherCategory,
} from "../src/ledger/categories";
import { createExpense } from "../src/ledger/expenses";
import { deleteMovement } from "../src/ledger/last-movement";

/**
 * Categorías más inteligentes (16/10): un gasto que no encaja va a "Otros" (que siempre existe),
 * nunca a la primera de la lista; y la IA recibe cómo categoriza el usuario sus gastos recientes.
 */
describe("categorías: Otros como red y ejemplos del usuario", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  let phoneId: string;
  const run = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(t.db, tenantId, fn);
  const cat = async (name: string) => {
    const [row] = await run((tx) =>
      tx
        .select()
        .from(schema.category)
        .where(
          and(
            eq(schema.category.tenantId, tenantId),
            sql`lower(${schema.category.name}) = lower(${name})`,
          ),
        ),
    );
    return row;
  };

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Javier",
      businessType: "car_wash",
      ownerPhone: "584121234567",
    });
    const [phone] = await run((tx) => tx.select().from(schema.phoneNumber));
    phoneId = phone?.id as string;
    await t.db
      .insert(schema.bcvRate)
      .values({ effectiveDate: "2026-10-16", rate: "880.12000000", source: "test" });
  });
  afterAll(() => t.close());

  it("sin 'Otros' en la lista no cae en la primera categoría", () => {
    const list = [
      { id: "a", name: "Comida en Casa" },
      { id: "b", name: "Hogar y servicios" },
    ];
    expect(defaultCategoryId(list)).toBeNull();
    expect(defaultCategoryId([...list, { id: "c", name: "Otros" }])).toBe("c");
  });

  it("ensureOtherCategory la crea si falta, la reactiva si estaba apagada y no la duplica", async () => {
    // Un registro con categorías propias, sin "Otros" (como la cuenta de Javier).
    await run((tx) =>
      tx.delete(schema.category).where(sql`lower(${schema.category.name}) = 'otros'`),
    );
    expect(await cat("Otros")).toBeUndefined();
    await run((tx) => ensureOtherCategory(tx, tenantId));
    const created = await cat("Otros");
    expect(created).toMatchObject({ kind: "expense", isActive: true });
    await run((tx) =>
      tx
        .update(schema.category)
        .set({ isActive: false })
        .where(eq(schema.category.id, created?.id as string)),
    );
    await run((tx) => ensureOtherCategory(tx, tenantId));
    await run((tx) => ensureOtherCategory(tx, tenantId));
    const all = await run((tx) =>
      tx.select().from(schema.category).where(sql`lower(${schema.category.name}) = 'otros'`),
    );
    expect(all).toHaveLength(1);
    expect(all[0]?.isActive).toBe(true);
    const log = await run((tx) =>
      tx
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.entityId, created?.id as string)),
    );
    expect(log.map((l) => [l.action, l.actorType])).toEqual([
      ["create", "system"],
      ["update", "system"],
    ]);
  });

  it("los ejemplos: una vez por descripción, la categoría más reciente, sin borrados ni 'Otros'", async () => {
    const otros = (await cat("Otros"))?.id as string;
    const [first, second] = await run((tx) =>
      tx
        .select()
        .from(schema.category)
        .where(
          and(eq(schema.category.isActive, true), sql`lower(${schema.category.name}) <> 'otros'`),
        )
        .orderBy(schema.category.sortOrder)
        .limit(2),
    );
    const add = (description: string, categoryId: string) =>
      run((tx) =>
        createExpense(tx, {
          tenantId,
          businessDate: asIsoDate("2026-10-16"),
          amount: new Decimal(5),
          currency: "USD",
          categoryId,
          description,
          sourceChannel: "text",
          actor: { phoneId },
        }),
      );
    // Mismo gasto en dos transacciones: gana la más reciente (la corrección).
    await add("Brocha y batería", first?.id as string);
    await add("brocha y batería ", second?.id as string);
    await add("Pan", otros);
    const gone = await add("Chicha", first?.id as string);
    await run((tx) =>
      deleteMovement(tx, { tenantId, movementId: gone.id, actor: { phoneId }, now: new Date() }),
    );
    const examples = await run((tx) => categoryExamples(tx, tenantId));
    expect(examples).toEqual([{ description: "brocha y batería", category: second?.name }]);
  });

  it("fuentes de ingreso: se crean una vez, no se duplican y 'Otros ingresos' vuelve si la apagan", async () => {
    const income = () =>
      run((tx) =>
        tx
          .select({ name: schema.category.name, isActive: schema.category.isActive })
          .from(schema.category)
          .where(and(eq(schema.category.tenantId, tenantId), eq(schema.category.kind, "income")))
          .orderBy(schema.category.sortOrder),
      );
    await run((tx) => ensureIncomeCategories(tx, tenantId));
    await run((tx) => ensureIncomeCategories(tx, tenantId));
    expect((await income()).map((c) => c.name)).toEqual([
      "Salario",
      "Freelance",
      "Negocio propio",
      "Remesas",
      "Bonos y extras",
      "Alquileres",
      "Otros ingresos",
    ]);
    // Apagar "Freelance" se respeta; apagar "Otros ingresos" no (es la red de la IA).
    await run((tx) =>
      tx
        .update(schema.category)
        .set({ isActive: false })
        .where(
          and(
            eq(schema.category.kind, "income"),
            sql`${schema.category.name} in ('Freelance', 'Otros ingresos')`,
          ),
        ),
    );
    await run((tx) => ensureIncomeCategories(tx, tenantId));
    const after = await income();
    expect(after).toHaveLength(7);
    expect(after.find((c) => c.name === "Freelance")?.isActive).toBe(false);
    expect(after.find((c) => c.name === "Otros ingresos")?.isActive).toBe(true);
  });
});
