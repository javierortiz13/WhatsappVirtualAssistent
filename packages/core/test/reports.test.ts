import { eq, schema, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asIsoDate } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";
import { accountBalances, accountDays, createAccount } from "../src/ledger/accounts";
import { createExpense, findCategory } from "../src/ledger/expenses";
import { createIncomeDayTotal, createIncomeSingle } from "../src/ledger/income";
import { categoryTotal, dailyClose, periodSummary, resolvePeriod } from "../src/ledger/reports";
import { renderSummary } from "../src/ledger/summary";
import { createTransfer } from "../src/ledger/transfers";

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
    expect(c.cashSalesUsd.toFixed(2)).toBe("200.00");
    expect(c.cashSalesVes.toFixed(2)).toBe("0.00");
    // Sin cuentas: ni "debería haber en caja" ni aviso de movimientos sin cuenta.
    expect(c.cash).toBeNull();
    expect(c.unassigned).toBeNull();
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
    if (insumos.found) {
      expect(insumos.usd.toFixed(2)).toBe("40.00");
      // Los gastos de la categoría, del más reciente al más viejo.
      expect(insumos.items.map((i) => [i.date, i.description, i.amount.toFixed(2)])).toEqual([
        ["2026-09-29", "Champú", "27.00"],
        ["2026-09-10", "Cera", "13.00"],
      ]);
    }
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
    expect(body).toContain("Ventas en efectivo: $200,00 · Bs 0,00");
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
    const catBody = (cat as { body: string }).body;
    expect(catBody).toContain(
      "Insumos de lavado, septiembre (1 al 29): *$40,00* (Bs 34.216,00) en 2 gastos.\n\nmar 29/09 · Champú · $27,00\njue 10/09 · Cera · $13,00\n\nTodos en el panel: https://caja.test/movimientos?mes=2026-09&tipo=expense&categoria=",
    );
    expect(catBody).not.toContain("más.");

    const empty = await withTenant(t.db, tenantId, (tx) =>
      renderSummary(tx, { ...base, period: "yesterday" }),
    );
    expect((empty as { body: string }).body).toContain("No tengo movimientos registrados ayer.");
  });
});

/**
 * Lo que debería haber en caja (PRD cash-in-drawer, US-002 y US-008), con el ejemplo del PRD: un
 * autolavado con Efectivo $ (apertura $50, el fondo de la mañana), Efectivo Bs, Banesco, BofA y
 * Zelle. Al cierre: $105,00 y Bs 18.000,00; hoy +$55,00 y +Bs 18.000,00.
 */
describe("efectivo en caja desde las cuentas", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  let phoneId: string;
  const day = asIsoDate("2026-10-19");
  const yesterday = asIsoDate("2026-10-18");
  const ids: Record<string, string> = {};
  const id = (name: string) => ids[name] as string;
  let comidaId = "";
  const run = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(t.db, tenantId, fn);

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Autolavado",
      businessType: "car_wash",
      ownerPhone: "584121234567",
    });
    phoneId = (await run((tx) => tx.select().from(schema.phoneNumber)))[0]?.id as string;
    await t.db.insert(schema.bcvRate).values(
      ["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"].map((d) => ({
        effectiveDate: d,
        rate: "1000.00000000",
        source: "test",
      })),
    );
    const actor = { phoneId };
    await run(async (tx) => {
      for (const [name, currency, kind, opening] of [
        ["Efectivo $", "USD", "cash", "50"],
        ["Efectivo Bs", "VES", "cash", "0"],
        ["Banesco", "VES", "bank", "0"],
        ["BofA", "USD", "bank", "0"],
        ["Zelle", "USD", "zelle", "0"],
      ] as const) {
        const a = await createAccount(tx, {
          tenantId,
          name,
          currency,
          kind,
          openingBalance: new Decimal(opening),
          openingKnown: true,
          openingDate: yesterday,
          actor,
          channel: "whatsapp",
        });
        ids[name] = a.id;
      }
      comidaId = (await findCategory(tx, tenantId, "Comida del personal"))?.id ?? "";
      // Una venta por Zelle antes de abrir las cuentas: igual cuenta en el saldo.
      await createIncomeSingle(tx, {
        tenantId,
        businessDate: asIsoDate("2026-10-17"),
        actor,
        sourceChannel: "text",
        line: { method: "zelle", amount: new Decimal(10), currency: "USD", accountId: id("Zelle") },
        description: "Carro",
      });
      // 1. "hoy vendí 350$: 200 efectivo, 100 pago móvil, 50 zelle"
      await createIncomeDayTotal(tx, {
        tenantId,
        businessDate: day,
        actor,
        sourceChannel: "text",
        replace: false,
        lines: [
          {
            method: "cash_usd",
            amount: new Decimal(200),
            currency: "USD",
            accountId: id("Efectivo $"),
          },
          {
            method: "pago_movil",
            amount: new Decimal(100),
            currency: "USD",
            accountId: id("Banesco"),
          },
          { method: "zelle", amount: new Decimal(50), currency: "USD", accountId: id("Zelle") },
        ],
      });
      // 2. "vendí 50.000 bs en efectivo"
      await createIncomeSingle(tx, {
        tenantId,
        businessDate: day,
        actor,
        sourceChannel: "text",
        line: {
          method: "cash_ves",
          amount: new Decimal(50000),
          currency: "VES",
          accountId: id("Efectivo Bs"),
        },
        description: "Lavado",
      });
      // 3, 4 y 5: champú, comida del personal y hielo.
      for (const [amount, currency, description, account] of [
        ["25", "USD", "Champú", "Efectivo $"],
        ["20", "USD", "Comida del personal", "Efectivo $"],
        ["12000", "VES", "Hielo", "Efectivo Bs"],
      ] as const)
        await createExpense(tx, {
          tenantId,
          businessDate: day,
          amount: new Decimal(amount),
          currency,
          categoryId: comidaId || null,
          description,
          sourceChannel: "text",
          actor,
          accountId: ids[account] ?? null,
        });
      // 6 y 7: los depósitos son transferencias.
      for (const [from, to, amount] of [
        ["Efectivo $", "BofA", "100"],
        ["Efectivo Bs", "Banesco", "20000"],
      ] as const)
        await createTransfer(tx, {
          tenantId,
          fromAccountId: ids[from] as string,
          toAccountId: ids[to] as string,
          fromAmount: new Decimal(amount),
          toAmount: new Decimal(amount),
          fee: null,
          businessDate: day,
          description: null,
          actor,
          channel: "whatsapp",
        });
    });
  });
  afterAll(() => t.close());

  const figures = async (date: typeof day) =>
    Object.fromEntries(
      (await run((tx) => accountDays(tx, tenantId, date))).map((a) => [
        a.name,
        [a.in, a.out, a.net, a.balanceEnd].map((d) => d.toFixed(2)),
      ]),
    );

  it("por cuenta: lo que entró, salió y quedó ese día", async () => {
    const f = await figures(day);
    expect(f["Efectivo $"]).toEqual(["200.00", "145.00", "55.00", "105.00"]);
    expect(f["Efectivo Bs"]).toEqual(["50000.00", "32000.00", "18000.00", "18000.00"]);
    // Hoy coincide con el saldo de "mis cuentas".
    const balances = await run((tx) => accountBalances(tx, tenantId));
    for (const b of balances) expect(f[b.name]?.[3]).toBe(b.balance.toFixed(2));
  });

  it("un día pasado da el saldo de ese día; antes de la apertura no entra el saldo inicial", async () => {
    const before = await figures(yesterday);
    expect(before["Efectivo $"]).toEqual(["0.00", "0.00", "0.00", "50.00"]);
    const preOpening = await figures(asIsoDate("2026-10-17"));
    expect(preOpening["Efectivo $"]?.[3]).toBe("0.00");
    // La venta por Zelle de antes de la apertura sí cuenta.
    expect(preOpening.Zelle).toEqual(["10.00", "0.00", "10.00", "10.00"]);
    expect((await figures(day)).Zelle?.[3]).toBe("60.00");
  });

  it("el cierre suma las cuentas de efectivo por moneda", async () => {
    const c = await run((tx) => dailyClose(tx, tenantId, day));
    expect(c.cash?.usd?.balanceEnd.toFixed(2)).toBe("105.00");
    expect(c.cash?.usd?.net.toFixed(2)).toBe("55.00");
    expect(c.cash?.ves?.balanceEnd.toFixed(2)).toBe("18000.00");
    expect(c.cash?.ves?.net.toFixed(2)).toBe("18000.00");
    expect(c.cashSalesUsd.toFixed(2)).toBe("200.00");
    expect(c.cashSalesVes.toFixed(2)).toBe("50000.00");
    expect(c.unassigned).toEqual({
      sales: { count: 0, usd: new Decimal(0) },
      expenses: { count: 0, usd: new Decimal(0) },
    });
    const prev = await run((tx) => dailyClose(tx, tenantId, yesterday));
    expect(prev.cash?.usd?.balanceEnd.toFixed(2)).toBe("50.00");
    expect(prev.cash?.usd?.net.toFixed(2)).toBe("0.00");
  });

  it("lo que no tiene cuenta no entra en la caja y se cuenta aparte: ventas y gastos", async () => {
    await run(async (tx) => {
      // #4 sin cuenta (nadie dijo cómo se pagó la comida del personal).
      await tx
        .update(schema.movement)
        .set({ accountId: null })
        .where(eq(schema.movement.description, "Comida del personal"));
    });
    let c = await run((tx) => dailyClose(tx, tenantId, day));
    expect(c.cash?.usd?.balanceEnd.toFixed(2)).toBe("125.00");
    expect(c.unassigned?.expenses.count).toBe(1);
    expect(c.unassigned?.expenses.usd.toFixed(2)).toBe("20.00");
    expect(c.unassigned?.sales.count).toBe(0);
    await run(async (tx) => {
      await createIncomeSingle(tx, {
        tenantId,
        businessDate: day,
        actor: { phoneId },
        sourceChannel: "text",
        line: { method: "unspecified", amount: new Decimal(30), currency: "USD" },
        description: "Lavado",
      });
      await createExpense(tx, {
        tenantId,
        businessDate: day,
        amount: new Decimal(25),
        currency: "USD",
        categoryId: null,
        description: "Trapos",
        sourceChannel: "text",
        actor: { phoneId },
      });
    });
    c = await run((tx) => dailyClose(tx, tenantId, day));
    expect([c.unassigned?.sales.count, c.unassigned?.sales.usd.toFixed(2)]).toEqual([1, "30.00"]);
    expect([c.unassigned?.expenses.count, c.unassigned?.expenses.usd.toFixed(2)]).toEqual([
      2,
      "45.00",
    ]);
  });

  it("solo con Efectivo $: la parte en Bs es null (no hay gaveta en Bs)", async () => {
    await run(async (tx) => {
      await tx
        .update(schema.account)
        .set({ archivedAt: new Date() })
        .where(eq(schema.account.id, ids["Efectivo Bs"] as string));
    });
    const c = await run((tx) => dailyClose(tx, tenantId, day));
    expect(c.cash?.ves).toBeNull();
    expect(c.cash?.usd).not.toBeNull();
  });
});
