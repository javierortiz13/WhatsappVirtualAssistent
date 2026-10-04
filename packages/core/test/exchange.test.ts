import { eq, schema, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asIsoDate } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";
import { applyBsChoice, createExpenseDraft, createExpensesDraft } from "../src/ledger/drafts";
import {
  completeExchange,
  createExchangeLot,
  deleteExchangeLot,
  ExchangeError,
  exchangeLots,
  planAllocation,
  planRate,
  releaseAllocation,
  saveAllocation,
} from "../src/ledger/exchange";
import { createExpense } from "../src/ledger/expenses";
import { amendMovement, computeAmend, deleteMovement } from "../src/ledger/last-movement";

/** Lotes de cambio USDT → Bs (0012): FIFO, tasa ponderada, faltante y devolución. */
describe("lotes de cambio", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  let phoneId: string;
  const now = new Date("2026-10-04T15:00:00Z");
  const day = asIsoDate("2026-10-04");
  const run = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(t.db, tenantId, fn);

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Javier",
      businessType: "other",
      ownerPhone: "584121234567",
    });
    phoneId = (await run((tx) => tx.select().from(schema.phoneNumber)))[0]?.id ?? "";
    await t.db
      .insert(schema.bcvRate)
      .values({ effectiveDate: "2026-10-02", rate: "866.56000000", source: "test" });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await run(async (tx) => {
      await tx.delete(schema.exchangeAllocation);
      await tx.update(schema.exchangeLot).set({ deletedAt: now });
    });
  });

  const lot = (usd: string, rate: string, date = "2026-10-01") =>
    run((tx) =>
      createExchangeLot(tx, {
        tenantId,
        businessDate: date,
        usd: new Decimal(usd),
        ves: new Decimal(usd).mul(rate),
        rate: new Decimal(rate),
        actor: { phoneId },
        channel: "whatsapp",
      }),
    );

  /** Un gasto en Bs guardado de los lotes, como lo hace Guardar. */
  const spend = (ves: string) =>
    run(async (tx) => {
      const plan = await planAllocation(tx, tenantId, new Decimal(ves), { lock: true });
      if (!plan) throw new Error("sin lotes");
      const r = planRate(plan, day);
      const created = await createExpense(tx, {
        tenantId,
        businessDate: day,
        amount: new Decimal(ves),
        currency: "VES",
        categoryId: null,
        description: "Mercado",
        sourceChannel: "text",
        actor: { phoneId },
        rate: { id: null, value: r.value.toFixed(8), effectiveDate: day, source: "exchange" },
      });
      await saveAllocation(tx, tenantId, created.id, plan.parts);
      return { created, plan };
    });

  const remaining = () =>
    run(async (tx) => (await exchangeLots(tx, tenantId)).map((l) => l.vesRemaining.toFixed(2)));

  it("completa un cambio con dos de sus tres datos", () => {
    const d = (v: string | null) => (v ? new Decimal(v) : null);
    expect(completeExchange({ usd: d("100"), ves: null, rate: d("970") })).toMatchObject({
      ves: new Decimal("97000"),
    });
    expect(completeExchange({ usd: d("100"), ves: d("97000"), rate: null })?.rate.toFixed(2)).toBe(
      "970.00",
    );
    expect(completeExchange({ usd: null, ves: d("48500"), rate: d("970") })?.usd.toFixed(2)).toBe(
      "50.00",
    );
    expect(completeExchange({ usd: d("100"), ves: null, rate: null })).toBeNull();
  });

  it("un gasto toma del lote más viejo y queda a su tasa", async () => {
    await lot("100", "970", "2026-10-01");
    await lot("50", "990", "2026-10-03");
    const { created, plan } = await spend("9700");
    expect(created.amountUsd.toFixed(2)).toBe("10.00");
    expect(plan.remainingAfter.toFixed(2)).toBe("136800.00");
    expect(await remaining()).toEqual(["87300.00", "49500.00"]);
    const [mv] = await run((tx) =>
      tx.select().from(schema.movement).where(eq(schema.movement.id, created.id)),
    );
    expect(mv).toMatchObject({ rateSource: "exchange", rateId: null, amountUsd: "10.00" });
  });

  it("un gasto que cruza dos lotes queda a la tasa ponderada y el total cuadra", async () => {
    await lot("10", "970", "2026-10-01"); // Bs 9.700
    await lot("100", "1000", "2026-10-03"); // Bs 100.000
    const { created } = await spend("19700"); // 9.700 a 970 ($10) + 10.000 a 1000 ($10)
    expect(created.amountUsd.toFixed(2)).toBe("20.00");
    expect(created.rateValue.toFixed(2)).toBe("985.00");
    expect(await remaining()).toEqual(["0.00", "90000.00"]);
  });

  it("si los lotes no alcanzan, lo que falta va a la tasa del último cambio", async () => {
    await lot("10", "970"); // Bs 9.700
    const plan = await run((tx) => planAllocation(tx, tenantId, new Decimal("19400")));
    expect(plan?.uncoveredVes.toFixed(2)).toBe("9700.00");
    expect(plan?.usd.toFixed(2)).toBe("20.00");
    expect(plan?.remainingAfter.toFixed(2)).toBe("0.00");
  });

  it("borrar el gasto devuelve sus Bs a los lotes", async () => {
    await lot("10", "970");
    await lot("100", "1000", "2026-10-03");
    const { created } = await spend("19700");
    await run((tx) =>
      deleteMovement(tx, { tenantId, movementId: created.id, actor: { phoneId }, now }),
    );
    expect(await remaining()).toEqual(["9700.00", "100000.00"]);
    const allocs = await run((tx) => tx.select().from(schema.exchangeAllocation));
    expect(allocs).toHaveLength(0);
  });

  it("corregir el monto devuelve y vuelve a tomar, con la tasa recalculada", async () => {
    await lot("10", "970");
    await lot("100", "1000", "2026-10-03");
    const { created } = await spend("9700");
    const [mv] = await run((tx) =>
      tx.select().from(schema.movement).where(eq(schema.movement.id, created.id)),
    );
    if (!mv) throw new Error("sin movimiento");
    const draft = await run((tx) =>
      computeAmend(tx, {
        movement: mv,
        categoryName: null,
        changes: { amount: new Decimal("19700") },
      }),
    );
    // La vista previa cuenta los Bs que el gasto devolvería: 9.700 a 970 + 10.000 a 1000.
    expect(draft.after.amountUsd).toBe("20.00");
    await run((tx) => amendMovement(tx, { tenantId, draft, actor: { phoneId }, now }));
    expect(await remaining()).toEqual(["0.00", "90000.00"]);
    // Pasarlo a dólares suelta los lotes y usa la BCV.
    const [mv2] = await run((tx) =>
      tx.select().from(schema.movement).where(eq(schema.movement.id, created.id)),
    );
    if (!mv2) throw new Error("sin movimiento");
    const toUsd = await run((tx) =>
      computeAmend(tx, { movement: mv2, categoryName: null, changes: { currency: "USD" } }),
    );
    expect(toUsd.after.rateSource).toBe("bcv");
    await run((tx) => amendMovement(tx, { tenantId, draft: toUsd, actor: { phoneId }, now }));
    expect(await remaining()).toEqual(["9700.00", "100000.00"]);
  });

  it("borradores: 'exchange' usa los lotes; un borrador de varios no cuenta dos veces los mismos Bs", async () => {
    await lot("10", "970");
    await lot("100", "1000", "2026-10-03");
    const base = {
      tenantId,
      phoneId,
      currency: "VES" as const,
      currencyInferred: false,
      categoryId: null,
      categoryName: null,
      description: "x",
      businessDate: day,
      sourceChannel: "text" as const,
      sourceMessageId: null,
      attachmentId: null,
      transcript: null,
      bsRate: "exchange" as const,
    };
    const one = await run((tx) =>
      createExpenseDraft(tx, { ...base, amount: new Decimal("9700") }, now),
    );
    expect(one.draft).toMatchObject({ rateSource: "exchange", amountUsd: "10.00" });
    expect(one.draft.exchange?.remainingAfter).toBe("100000.00");
    const many = await run((tx) =>
      createExpensesDraft(
        tx,
        [
          { ...base, amount: new Decimal("9700") },
          { ...base, amount: new Decimal("10000") },
        ],
        now,
      ),
    );
    // El segundo ya no encuentra el lote a 970: sale del de 1000.
    expect(many.draft.items.map((i) => i.amountUsd)).toEqual(["10.00", "10.00"]);
    expect(many.draft.items[1]?.rateValue).toBe("1000.00000000");
  });

  it("modo preguntar: el borrador va a la BCV con los dos cálculos; la respuesta lo rehace", async () => {
    await lot("10", "970");
    const ask = await run((tx) =>
      createExpenseDraft(
        tx,
        {
          tenantId,
          phoneId,
          amount: new Decimal("9700"),
          currency: "VES",
          currencyInferred: false,
          categoryId: null,
          categoryName: null,
          description: "x",
          businessDate: day,
          sourceChannel: "text",
          sourceMessageId: null,
          attachmentId: null,
          transcript: null,
          bsRate: "ask",
        },
        now,
      ),
    );
    expect(ask.draft.rateSource).toBe("bcv");
    expect(ask.draft.bsChoice).toMatchObject({ exchangeUsd: "10.00", bcvUsd: "11.19" });
    const [usdt] = await run((tx) => applyBsChoice(tx, tenantId, [ask.draft], "usdt"));
    expect(usdt).toMatchObject({ rateSource: "exchange", amountUsd: "10.00", bsChoice: null });
    const [bcv] = await run((tx) => applyBsChoice(tx, tenantId, [ask.draft], "bcv"));
    expect(bcv).toMatchObject({ rateSource: "bcv", amountUsd: "11.19", bsChoice: null });
  });

  it("un cambio usado no se puede borrar; uno sin usar sí", async () => {
    const used = await lot("10", "970");
    const free = await lot("5", "980", "2026-10-03");
    await spend("970");
    await expect(
      run((tx) => deleteExchangeLot(tx, { tenantId, lotId: used, actor: { phoneId }, now })),
    ).rejects.toBeInstanceOf(ExchangeError);
    await run((tx) => deleteExchangeLot(tx, { tenantId, lotId: free, actor: { phoneId }, now }));
    expect((await run((tx) => exchangeLots(tx, tenantId))).map((l) => l.id)).toEqual([used]);
  });

  it("releaseAllocation sin asignaciones no toca nada", async () => {
    await lot("10", "970");
    const back = await run((tx) => releaseAllocation(tx, tenantId, crypto.randomUUID()));
    expect(back.size).toBe(0);
    expect(await remaining()).toEqual(["9700.00"]);
  });
});
