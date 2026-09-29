import { schema, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asIsoDate } from "../src/domain/dates.js";
import { Decimal } from "../src/domain/money.js";
import { createExpenseDraft, expirePendingActions } from "../src/ledger/drafts.js";
import { createExpense, expenseTotalForDay, findCategory } from "../src/ledger/expenses.js";

describe("ledger de gastos", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  let phoneId: string;
  const now = new Date("2026-09-29T15:00:00Z");

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Autolavado",
      businessType: "car_wash",
      ownerPhone: "584121234567",
    });
    phoneId =
      (await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.phoneNumber)))[0]?.id ?? "";
    await t.db.insert(schema.bcvRate).values([
      { effectiveDate: "2026-09-25", rate: "850.00000000", source: "test" },
      { effectiveDate: "2026-09-29", rate: "858.00000000", source: "test" },
    ]);
  });
  afterAll(() => t.close());

  it("crea un gasto en USD con ambos equivalentes, tasa congelada y auditoría en la misma transacción", async () => {
    const cat = await withTenant(t.db, tenantId, (tx) =>
      findCategory(tx, tenantId, "insumos de lavado"),
    );
    expect(cat?.name).toBe("Insumos de lavado");
    const created = await withTenant(t.db, tenantId, (tx) =>
      createExpense(tx, {
        tenantId,
        businessDate: asIsoDate("2026-09-29"),
        amount: new Decimal("15"),
        currency: "USD",
        categoryId: cat?.id ?? null,
        description: "Champú",
        sourceChannel: "text",
        actor: { phoneId },
      }),
    );
    expect(created.amountVes.toFixed(2)).toBe("12870.00");
    expect(created.rateEffectiveDate).toBe("2026-09-29");
    const [mov] = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.movement));
    expect(mov).toMatchObject({
      amount: "15.00",
      currency: "USD",
      amountUsd: "15.00",
      amountVes: "12870.00",
      rateValue: "858.00000000",
      createdByPhoneId: phoneId,
    });
    const audit = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.auditLog));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "create",
      entity: "movement",
      entityId: created.id,
      actorType: "phone",
      channel: "whatsapp",
    });
  });

  it("gasto en Bs de un domingo usa la tasa del viernes anterior", async () => {
    const created = await withTenant(t.db, tenantId, (tx) =>
      createExpense(tx, {
        tenantId,
        businessDate: asIsoDate("2026-09-27"),
        amount: new Decimal("450000"),
        currency: "VES",
        categoryId: null,
        description: "Gasolina",
        sourceChannel: "text",
        actor: { phoneId },
      }),
    );
    expect(created.rateEffectiveDate).toBe("2026-09-25");
    expect(created.amountUsd.toFixed(2)).toBe("529.41");
  });

  it("total del día suma solo gastos vivos de esa fecha", async () => {
    const total = await withTenant(t.db, tenantId, (tx) =>
      expenseTotalForDay(tx, tenantId, asIsoDate("2026-09-29")),
    );
    expect(total.usd.toFixed(2)).toBe("15.00");
    expect(total.count).toBe(1);
  });

  it("monto cero o sin tasa falla sin escribir", async () => {
    await expect(
      withTenant(t.db, tenantId, (tx) =>
        createExpense(tx, {
          tenantId,
          businessDate: asIsoDate("2026-09-29"),
          amount: new Decimal("0"),
          currency: "USD",
          categoryId: null,
          description: null,
          sourceChannel: "text",
          actor: { phoneId },
        }),
      ),
    ).rejects.toThrow(/monto/);
    await expect(
      withTenant(t.db, tenantId, (tx) =>
        createExpense(tx, {
          tenantId,
          businessDate: asIsoDate("2026-01-05"),
          amount: new Decimal("1"),
          currency: "USD",
          categoryId: null,
          description: null,
          sourceChannel: "text",
          actor: { phoneId },
        }),
      ),
    ).rejects.toThrow(/tasa/);
  });

  it("un borrador nuevo reemplaza al anterior y expira a los 10 minutos", async () => {
    const first = await withTenant(t.db, tenantId, (tx) =>
      createExpenseDraft(
        tx,
        {
          tenantId,
          phoneId,
          amount: new Decimal("20"),
          currency: "USD",
          currencyInferred: true,
          categoryId: null,
          categoryName: null,
          description: "Hielo",
          businessDate: asIsoDate("2026-09-29"),
          sourceChannel: "text",
          sourceMessageId: null,
          attachmentId: null,
          transcript: null,
        },
        now,
      ),
    );
    expect(first.replacedPrevious).toBe(false);
    expect(first.draft.amountVes).toBe("17160.00");
    const second = await withTenant(t.db, tenantId, (tx) =>
      createExpenseDraft(
        tx,
        {
          tenantId,
          phoneId,
          amount: new Decimal("2000"),
          currency: "VES",
          currencyInferred: true,
          categoryId: null,
          categoryName: null,
          description: "Hielo",
          businessDate: asIsoDate("2026-09-29"),
          sourceChannel: "text",
          sourceMessageId: null,
          attachmentId: null,
          transcript: null,
        },
        now,
      ),
    );
    expect(second.replacedPrevious).toBe(true);
    const rows = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.pendingAction));
    expect(rows.map((r) => r.status).sort()).toEqual(["cancelled", "pending"]);
    expect(await expirePendingActions(t.db, new Date(now.getTime() + 11 * 60_000))).toBe(1);
  });
});
