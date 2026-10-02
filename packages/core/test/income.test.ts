import { schema, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asIsoDate } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";
import {
  createIncomeDayTotalDraft,
  createIncomeSingleDraft,
  resolveMismatch,
} from "../src/ledger/drafts";
import { createExpense } from "../src/ledger/expenses";
import {
  createIncomeDayTotal,
  createIncomeSingle,
  dayTotals,
  existingDayTotal,
} from "../src/ledger/income";

describe("ledger de ingresos", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  let phoneId: string;
  const today = asIsoDate("2026-09-29");
  const now = new Date("2026-09-29T15:00:00Z");

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Autolavado",
      businessType: "car_wash",
      ownerPhone: "584121234567",
    });
    const [phone] = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.phoneNumber));
    phoneId = phone?.id as string;
    await t.db
      .insert(schema.bcvRate)
      .values({ effectiveDate: "2026-09-29", rate: "858.00000000", source: "test" });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await withTenant(t.db, tenantId, async (tx) => {
      await tx.delete(schema.pendingAction);
      await tx.delete(schema.movement);
    });
  });

  const common = () => ({
    tenantId,
    businessDate: today,
    actor: { phoneId } as const,
    sourceChannel: "text" as const,
  });

  it("total del día: una fila por método, cada una con su moneda y su equivalente, con auditoría", async () => {
    const r = await withTenant(t.db, tenantId, (tx) =>
      createIncomeDayTotal(tx, {
        ...common(),
        lines: [
          { method: "cash_usd", amount: new Decimal(200), currency: "USD" },
          { method: "pago_movil", amount: new Decimal(85800), currency: "VES" },
          { method: "punto", amount: new Decimal(50), currency: "USD" },
        ],
        replace: false,
      }),
    );
    expect(r.ids).toHaveLength(3);
    expect(r.totalUsd.toFixed(2)).toBe("350.00");
    expect(r.totalVes.toFixed(2)).toBe("300300.00");
    const rows = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.movement));
    expect(rows.map((m) => [m.type, m.origin, m.paymentMethod, m.currency, m.amountUsd])).toEqual([
      ["income", "day_total", "cash_usd", "USD", "200.00"],
      ["income", "day_total", "pago_movil", "VES", "100.00"],
      ["income", "day_total", "punto", "USD", "50.00"],
    ]);
    const audit = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.auditLog));
    expect(audit.filter((a) => a.action === "create")).toHaveLength(3);
    expect(
      await withTenant(t.db, tenantId, (tx) => existingDayTotal(tx, tenantId, today)),
    ).toMatchObject({
      count: 3,
    });
  });

  it("reemplazar da de baja lógica el total anterior y lo audita; agregar lo conserva", async () => {
    const line = {
      method: "cash_usd" as const,
      amount: new Decimal(100),
      currency: "USD" as const,
    };
    await withTenant(t.db, tenantId, (tx) =>
      createIncomeDayTotal(tx, { ...common(), lines: [line], replace: false }),
    );
    const added = await withTenant(t.db, tenantId, (tx) =>
      createIncomeDayTotal(tx, { ...common(), lines: [line], replace: false }),
    );
    expect(added.replaced).toBe(0);
    expect(
      (await withTenant(t.db, tenantId, (tx) => dayTotals(tx, tenantId, today))).salesUsd.toFixed(
        2,
      ),
    ).toBe("200.00");
    const replaced = await withTenant(t.db, tenantId, (tx) =>
      createIncomeDayTotal(tx, {
        ...common(),
        lines: [{ method: "zelle", amount: new Decimal(400), currency: "USD" }],
        replace: true,
      }),
    );
    expect(replaced.replaced).toBe(2);
    const live = await withTenant(t.db, tenantId, (tx) => dayTotals(tx, tenantId, today));
    expect(live.salesUsd.toFixed(2)).toBe("400.00");
    expect(live.count).toBe(1);
    const audit = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.auditLog));
    expect(audit.filter((a) => a.action === "delete")).toHaveLength(2);
  });

  it("ingreso suelto y totales del día junto a los gastos", async () => {
    await withTenant(t.db, tenantId, (tx) =>
      createIncomeSingle(tx, {
        ...common(),
        line: { method: "zelle", amount: new Decimal(30), currency: "USD" },
        description: "Carro del abogado",
      }),
    );
    await withTenant(t.db, tenantId, (tx) =>
      createExpense(tx, {
        tenantId,
        businessDate: today,
        amount: new Decimal(47),
        currency: "USD",
        categoryId: null,
        description: "Champú",
        sourceChannel: "text",
        actor: { phoneId },
      }),
    );
    const totals = await withTenant(t.db, tenantId, (tx) => dayTotals(tx, tenantId, today));
    expect(totals.salesUsd.toFixed(2)).toBe("30.00");
    expect(totals.expensesUsd.toFixed(2)).toBe("47.00");
    expect(totals.count).toBe(2);
    // El suelto no cuenta como "total del día ya registrado".
    expect(
      (await withTenant(t.db, tenantId, (tx) => existingDayTotal(tx, tenantId, today))).count,
    ).toBe(0);
  });

  it("borrador de venta: desglose que no cuadra, y las dos formas de resolverlo", async () => {
    const r = await withTenant(t.db, tenantId, (tx) =>
      createIncomeDayTotalDraft(
        tx,
        {
          tenantId,
          phoneId,
          businessDate: today,
          stated: { amount: new Decimal(350), currency: "USD" },
          lines: [
            { method: "cash_usd", amount: new Decimal(200), currency: "USD" },
            { method: "pago_movil", amount: new Decimal(100), currency: "USD" },
          ],
          sourceChannel: "text",
          sourceMessageId: null,
          transcript: null,
        },
        now,
      ),
    );
    expect(r.draft.mismatch).toEqual({
      statedUsd: "350.00",
      breakdownUsd: "300.00",
      statedCurrency: "USD",
      statedAmount: "350.00",
    });
    const stated = resolveMismatch(r.draft, "stated");
    expect(stated.mismatch).toBeNull();
    expect(stated.lines.map((l) => [l.method, l.amount])).toEqual([
      ["cash_usd", "200.00"],
      ["pago_movil", "100.00"],
      ["unspecified", "50.00"],
    ]);
    expect(stated.totalUsd).toBe("350.00");
    const breakdown = resolveMismatch(r.draft, "breakdown");
    expect(breakdown.lines).toHaveLength(2);
    expect(breakdown.totalUsd).toBe("300.00");
  });

  it("borrador solo con total: una línea 'Sin especificar'; con total ya registrado marca existingUsd", async () => {
    const only = await withTenant(t.db, tenantId, (tx) =>
      createIncomeDayTotalDraft(
        tx,
        {
          tenantId,
          phoneId,
          businessDate: today,
          stated: { amount: new Decimal(280), currency: "USD" },
          lines: [],
          sourceChannel: "text",
          sourceMessageId: null,
          transcript: null,
        },
        now,
      ),
    );
    expect(only.draft.lines).toEqual([
      {
        method: "unspecified",
        amount: "280.00",
        currency: "USD",
        amountUsd: "280.00",
        amountVes: "240240.00",
      },
    ]);
    expect(only.draft.existingUsd).toBeNull();
    await withTenant(t.db, tenantId, (tx) =>
      createIncomeDayTotal(tx, {
        ...common(),
        lines: [{ method: "cash_usd", amount: new Decimal(350), currency: "USD" }],
        replace: false,
      }),
    );
    const second = await withTenant(t.db, tenantId, (tx) =>
      createIncomeDayTotalDraft(
        tx,
        {
          tenantId,
          phoneId,
          businessDate: today,
          stated: { amount: new Decimal(400), currency: "USD" },
          lines: [],
          sourceChannel: "text",
          sourceMessageId: null,
          transcript: null,
        },
        now,
      ),
    );
    expect(second.draft.existingUsd).toBe("350.00");
    // Cola de borradores: uno nuevo no reemplaza al anterior salvo que sea una corrección.
    expect(second.replacedPrevious).toBe(false);
  });

  it("borrador de ingreso suelto congela la tasa y convierte", async () => {
    const r = await withTenant(t.db, tenantId, (tx) =>
      createIncomeSingleDraft(
        tx,
        {
          tenantId,
          phoneId,
          amount: new Decimal(85800),
          currency: "VES",
          currencyInferred: true,
          method: "pago_movil",
          description: "Moto",
          businessDate: today,
          sourceChannel: "text",
          sourceMessageId: null,
          transcript: null,
        },
        now,
      ),
    );
    expect(r.draft).toMatchObject({
      amountUsd: "100.00",
      amountVes: "85800.00",
      rateValue: "858.00000000",
    });
  });
});
