import { eq, schema, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asIsoDate } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";
import {
  createExpenseDraft,
  expirePendingActions,
  MAX_PENDING_PER_PHONE,
} from "../src/ledger/drafts";
import { createExpense, expenseTotalForDay, findCategory } from "../src/ledger/expenses";

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

  it("fecha anterior a toda la historia de tasas usa la primera conocida y lo marca", async () => {
    const m = await withTenant(t.db, tenantId, (tx) =>
      createExpense(tx, {
        tenantId,
        businessDate: asIsoDate("2026-01-05"),
        amount: new Decimal("1"),
        currency: "USD",
        categoryId: null,
        description: "Histórico",
        sourceChannel: "text",
        actor: { phoneId },
      }),
    );
    expect(m.rateValue.toFixed(2)).toBe("850.00");
    expect(m.rateEffectiveDate).toBe("2026-09-25");
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
    await withTenant(t.db, tenantId, (tx) => tx.delete(schema.movement));
    await t.db.delete(schema.bcvRate);
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
    await t.db.insert(schema.bcvRate).values([
      { effectiveDate: "2026-09-25", rate: "850.00000000", source: "test" },
      { effectiveDate: "2026-09-29", rate: "858.00000000", source: "test" },
    ]);
  });

  it("cola de borradores: uno nuevo se suma, una corrección reemplaza, tope de 5 y vencen a los 10 minutos", async () => {
    const draft = (amount: string, replaces: string | null = null) =>
      withTenant(t.db, tenantId, (tx) =>
        createExpenseDraft(
          tx,
          {
            tenantId,
            phoneId,
            amount: new Decimal(amount),
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
            replaces,
          },
          now,
        ),
      );
    const statuses = async () =>
      (await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.pendingAction)))
        .map((r) => r.status)
        .sort();
    const first = await draft("20");
    expect(first.replacedPrevious).toBe(false);
    expect(first.draft.amountVes).toBe("17160.00");
    // La factura sigue viva cuando llega otro gasto: los dos esperan su Guardar.
    const second = await draft("5");
    expect(second.replacedPrevious).toBe(false);
    expect(await statuses()).toEqual(["pending", "pending"]);
    // "no, eran 6": la corrección reemplaza solo al borrador indicado.
    const fixed = await draft("6", second.pendingId);
    expect(fixed.replacedPrevious).toBe(true);
    expect(await statuses()).toEqual(["cancelled", "pending", "pending"]);
    for (const a of ["1", "2", "3", "4"]) await draft(a);
    const pending = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.pendingAction).where(eq(schema.pendingAction.status, "pending")),
    );
    expect(pending).toHaveLength(MAX_PENDING_PER_PHONE);
    expect(await expirePendingActions(t.db, new Date(now.getTime() + 11 * 60_000))).toBe(
      MAX_PENDING_PER_PHONE,
    );
  });
});
