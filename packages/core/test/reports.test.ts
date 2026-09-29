import { schema, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asIsoDate } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";
import { createExpense, findCategory } from "../src/ledger/expenses";
import { createIncomeDayTotal, createIncomeSingle } from "../src/ledger/income";
import { categoryTotal, dailyClose, periodSummary, resolvePeriod } from "../src/ledger/reports";
import { renderSummary } from "../src/ledger/summary";

describe("cierre y consultas", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  let phoneId: string;
  const today = asIsoDate("2026-09-29");

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Autolavado",
      businessType: "car_wash",
      ownerPhone: "584121234567",
    });
    const [phone] = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.phoneNumber));
    phoneId = phone?.id as string;
    await t.db.insert(schema.bcvRate).values([
      { effectiveDate: "2026-09-01", rate: "850.00000000", source: "test" },
      { effectiveDate: "2026-09-29", rate: "858.00000000", source: "test" },
    ]);
    await withTenant(t.db, tenantId, async (tx) => {
      const insumos = await findCategory(tx, tenantId, "Insumos de lavado");
      const comida = await findCategory(tx, tenantId, "Comida del personal");
      const actor = { phoneId } as const;
      await createIncomeDayTotal(tx, {
        tenantId,
        businessDate: today,
        actor,
        sourceChannel: "text",
        replace: false,
        lines: [
          { method: "cash_usd", amount: new Decimal(200), currency: "USD" },
          { method: "pago_movil", amount: new Decimal(85800), currency: "VES" },
          { method: "punto", amount: new Decimal(50), currency: "USD" },
        ],
      });
      await createExpense(tx, {
        tenantId,
        businessDate: today,
        amount: new Decimal(27),
        currency: "USD",
        categoryId: insumos?.id ?? null,
        description: "Champú",
        sourceChannel: "text",
        actor,
      });
      await createExpense(tx, {
        tenantId,
        businessDate: today,
        amount: new Decimal(20),
        currency: "USD",
        categoryId: comida?.id ?? null,
        description: "Almuerzo",
        sourceChannel: "text",
        actor,
      });
      // Otro día del mes: una venta suelta y un gasto de insumos.
      await createIncomeSingle(tx, {
        tenantId,
        businessDate: asIsoDate("2026-09-10"),
        actor,
        sourceChannel: "text",
        line: { method: "zelle", amount: new Decimal(100), currency: "USD" },
        description: "Carro",
      });
      await createExpense(tx, {
        tenantId,
        businessDate: asIsoDate("2026-09-10"),
        amount: new Decimal(13),
        currency: "USD",
        categoryId: insumos?.id ?? null,
        description: "Cera",
        sourceChannel: "text",
        actor,
      });
    });
  });
  afterAll(() => t.close());

  it("cierre del día: ventas por método, gastos por categoría, neto en ambas monedas y efectivo", async () => {
    const c = await withTenant(t.db, tenantId, (tx) => dailyClose(tx, tenantId, today));
    expect(c.salesUsd.toFixed(2)).toBe("350.00");
    expect(
      c.salesByMethod.map((m) => [m.method, m.usd.toFixed(2), m.originalVes.toFixed(2)]),
    ).toEqual([
      ["cash_usd", "200.00", "0.00"],
      ["pago_movil", "100.00", "85800.00"],
      ["punto", "50.00", "0.00"],
    ]);
    expect(c.expensesUsd.toFixed(2)).toBe("47.00");
    expect(c.expensesByCategory.map((x) => [x.name, x.usd.toFixed(2)])).toEqual([
      ["Insumos de lavado", "27.00"],
      ["Comida del personal", "20.00"],
    ]);
    expect(c.netUsd.toFixed(2)).toBe("303.00");
    expect(c.netVes?.toFixed(2)).toBe("259974.00");
    expect(c.cashUsd.toFixed(2)).toBe("200.00");
    expect(c.count).toBe(5);
  });

  it("resumen del mes con los gastos más grandes y días con movimientos", async () => {
    const p = await withTenant(t.db, tenantId, (tx) =>
      periodSummary(tx, tenantId, asIsoDate("2026-09-01"), today),
    );
    expect(p.salesUsd.toFixed(2)).toBe("450.00");
    expect(p.expensesUsd.toFixed(2)).toBe("60.00");
    expect(p.netUsd.toFixed(2)).toBe("390.00");
    expect(p.topExpenses.map((x) => [x.name, x.usd.toFixed(2), x.count])).toEqual([
      ["Insumos de lavado", "40.00", 2],
      ["Comida del personal", "20.00", 1],
    ]);
    expect(p.daysWithMovements).toBe(2);
  });

  it("total por categoría, con coincidencia parcial y sugerencias si no existe", async () => {
    const insumos = await withTenant(t.db, tenantId, (tx) =>
      categoryTotal(tx, tenantId, asIsoDate("2026-09-01"), today, "insumos"),
    );
    expect(insumos).toMatchObject({ found: true, name: "Insumos de lavado", count: 2 });
    if (insumos.found) expect(insumos.usd.toFixed(2)).toBe("40.00");
    const nada = await withTenant(t.db, tenantId, (tx) =>
      categoryTotal(tx, tenantId, asIsoDate("2026-09-01"), today, "productos"),
    );
    expect(nada.found).toBe(false);
    if (!nada.found) expect(nada.suggestions).toHaveLength(3);
  });

  it("resolvePeriod: semana de lunes a domingo, mes calendario, custom acotado", () => {
    expect(resolvePeriod("this_week", today)).toEqual({ from: "2026-09-28", to: "2026-09-29" });
    expect(resolvePeriod("last_week", today)).toEqual({ from: "2026-09-21", to: "2026-09-27" });
    expect(resolvePeriod("this_month", today)).toEqual({ from: "2026-09-01", to: "2026-09-29" });
    expect(resolvePeriod("last_month", today)).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(resolvePeriod("custom", today, { from: null, to: null })).toEqual({ error: "missing" });
    expect(resolvePeriod("custom", today, { from: asIsoDate("2025-01-01"), to: today })).toEqual({
      error: "too_long",
    });
  });

  it("renderSummary: cierre con el formato de la Fase 4, mes, categoría y día vacío", async () => {
    const base = {
      tenantId,
      today,
      dashboardUrl: "https://caja.test",
      from: null,
      to: null,
      categoryName: null,
    };
    const close = await withTenant(t.db, tenantId, (tx) =>
      renderSummary(tx, { ...base, period: "today" }),
    );
    const body = (close as { body: string }).body;
    expect(body).toContain("📊 Cierre diario · hoy, mar 29/09");
    expect(body).toContain(
      "*Ventas: $350,00*\nEfectivo USD $200,00\nPago Móvil $100,00 (Bs 85.800,00)\nPunto $50,00",
    );
    expect(body).toContain(
      "*Gastos: $47,00*\nInsumos de lavado $27,00\nComida del personal $20,00",
    );
    expect(body).toContain("*Ventas menos gastos: $303,00* (Bs 259.974,00 a tasa 858,00)");
    expect(body).toContain("Efectivo en caja: $200,00 · Bs 0,00");
    expect(body).toContain("5 movimientos · Dashboard: https://caja.test");

    const month = await withTenant(t.db, tenantId, (tx) =>
      renderSummary(tx, { ...base, period: "this_month" }),
    );
    expect((month as { body: string }).body).toContain("📊 Cierre del mes · Septiembre (1 al 29)");
    expect((month as { body: string }).body).toContain(
      "Gastos más grandes:\nInsumos de lavado $40,00",
    );

    const cat = await withTenant(t.db, tenantId, (tx) =>
      renderSummary(tx, { ...base, period: "this_month", categoryName: "insumos" }),
    );
    expect((cat as { body: string }).body).toBe(
      "Insumos de lavado, septiembre (1 al 29): *$40,00* (Bs 34.216,00) en 2 gastos.",
    );

    const empty = await withTenant(t.db, tenantId, (tx) =>
      renderSummary(tx, { ...base, period: "yesterday" }),
    );
    expect((empty as { body: string }).body).toContain("No tengo movimientos registrados ayer.");
  });
});
