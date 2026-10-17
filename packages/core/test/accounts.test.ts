import { and, eq, schema, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asIsoDate } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";
import {
  AccountError,
  type AccountRef,
  accountBalances,
  archiveAccount,
  createAccount,
  listAccounts,
  namedAccount,
  netWorth,
  resolveAccount,
  updateAccount,
} from "../src/ledger/accounts";
import {
  createExchangeLot,
  exchangeLots,
  planAllocation,
  saveAllocation,
} from "../src/ledger/exchange";
import { createExpense } from "../src/ledger/expenses";
import type { PaymentMethod } from "../src/ledger/income";
import { createIncomeSingle } from "../src/ledger/income";
import { amendMovement, computeAmend, deleteMovement } from "../src/ledger/last-movement";

/** Cuentas (0013): saldos, saldo inicial a la BCV, lotes por cuenta y a qué cuenta va cada cosa. */
describe("cuentas", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  let phoneId: string;
  const now = new Date("2026-10-04T15:00:00Z");
  const day = asIsoDate("2026-10-04");
  const actor = () => ({ phoneId });
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

  const balanceOf = async (name: string) =>
    (await run((tx) => accountBalances(tx, tenantId)))
      .find((a) => a.name === name)
      ?.balance.toFixed(2);

  it("la primera cuenta en Bs adopta los cambios de antes; solo el resto del saldo va a la BCV", async () => {
    // Un cambio de antes de las cuentas, con Bs 9.700 usados.
    await run(async (tx) => {
      const lotId = await createExchangeLot(tx, {
        tenantId,
        businessDate: "2026-10-01",
        usd: new Decimal(100),
        ves: new Decimal(97000),
        rate: new Decimal(970),
        actor: actor(),
        channel: "whatsapp",
      });
      await tx
        .update(schema.exchangeLot)
        .set({ vesRemaining: "87300.00" })
        .where(eq(schema.exchangeLot.id, lotId));
    });
    const bdv = await run((tx) =>
      createAccount(tx, {
        tenantId,
        name: "Banco de Venezuela",
        currency: "VES",
        kind: "bank",
        openingBalance: new Decimal(100000),
        openingKnown: true,
        openingDate: day,
        actor: actor(),
        channel: "dashboard",
      }),
    );
    const lots = await run((tx) => exchangeLots(tx, tenantId));
    expect(lots.map((l) => [l.source, l.accountId === bdv.id, l.vesRemaining.toFixed(2)])).toEqual([
      ["exchange", true, "87300.00"],
      ["opening", true, "12700.00"],
    ]);
    // El lote del saldo inicial va a la BCV del día de apertura (la del viernes, publicada antes).
    expect(lots[1]?.rate.toFixed(2)).toBe("866.56");
    // El cambio adoptado ya está dentro del saldo inicial: no se suma otra vez.
    expect(await balanceOf("Banco de Venezuela")).toBe("100000.00");
  });

  it("un saldo inicial menor que lo que queda de los cambios los recorta, del más viejo", async () => {
    const t2 = await createTestDb();
    try {
      const tid = await seedTenant(t2.db, {
        name: "Otro",
        businessType: "other",
        ownerPhone: "584141111111",
      });
      await t2.db
        .insert(schema.bcvRate)
        .values({ effectiveDate: "2026-10-02", rate: "866.56000000", source: "test" });
      await withTenant(t2.db, tid, async (tx) => {
        const [ph] = await tx.select().from(schema.phoneNumber);
        const a = { phoneId: ph?.id ?? "" };
        for (const [usd, rate, date] of [
          ["10", "970", "2026-10-01"],
          ["10", "990", "2026-10-03"],
        ] as const)
          await createExchangeLot(tx, {
            tenantId: tid,
            businessDate: date,
            usd: new Decimal(usd),
            ves: new Decimal(usd).mul(rate),
            rate: new Decimal(rate),
            actor: a,
            channel: "whatsapp",
          });
        await createAccount(tx, {
          tenantId: tid,
          name: "Banesco",
          currency: "VES",
          kind: "bank",
          openingBalance: new Decimal(12000),
          openingKnown: true,
          openingDate: day,
          actor: a,
          channel: "dashboard",
        });
        const lots = await exchangeLots(tx, tid);
        // 9.700 + 9.900 = 19.600; tiene 12.000: se recortan 7.600 del cambio a 970.
        expect(lots.map((l) => l.vesRemaining.toFixed(2))).toEqual(["2100.00", "9900.00"]);
        expect(lots.every((l) => l.source === "exchange")).toBe(true);
        const [b] = await accountBalances(tx, tid);
        expect(b?.balance.toFixed(2)).toBe("12000.00");
      });
    } finally {
      await t2.close();
    }
  });

  it("gastos, ventas y cambios mueven el saldo de cada cuenta; el total pasa los Bs a la BCV de hoy", async () => {
    const binance = await run((tx) =>
      createAccount(tx, {
        tenantId,
        name: "Binance",
        currency: "USD",
        kind: "crypto",
        openingBalance: new Decimal(500),
        openingKnown: true,
        openingDate: day,
        actor: actor(),
        channel: "whatsapp",
      }),
    );
    const accounts = await run((tx) => listAccounts(tx, tenantId));
    const bdv = accounts.find((a) => a.name === "Banco de Venezuela") as AccountRef;
    await run(async (tx) => {
      // Cambio: 100 USDT de Binance → Bs 98.000 al BDV.
      await createExchangeLot(tx, {
        tenantId,
        businessDate: day,
        usd: new Decimal(100),
        ves: new Decimal(98000),
        rate: new Decimal(980),
        actor: actor(),
        channel: "whatsapp",
        accountId: bdv.id,
        fromAccountId: binance.id,
      });
      // Gasto de $20 pagado desde el BDV: resta sus Bs a la tasa del gasto.
      await createExpense(tx, {
        tenantId,
        businessDate: day,
        amount: new Decimal(20),
        currency: "USD",
        categoryId: null,
        description: "Repuesto",
        sourceChannel: "text",
        actor: actor(),
        accountId: bdv.id,
      });
      // Venta de 50 USDT que entra a Binance.
      await createIncomeSingle(tx, {
        tenantId,
        businessDate: day,
        line: { method: "other", amount: new Decimal(50), currency: "USD", accountId: binance.id },
        description: "Cliente",
        actor: actor(),
        sourceChannel: "text",
      });
    });
    // 100.000 + 98.000 − 20 × 866,56
    expect(await balanceOf("Banco de Venezuela")).toBe("180668.80");
    // 500 − 100 + 50
    expect(await balanceOf("Binance")).toBe("450.00");
    const nw = netWorth(await run((tx) => accountBalances(tx, tenantId)), new Decimal("866.56"));
    expect(nw.ves.toFixed(2)).toBe("180668.80");
    expect(nw.totalUsd?.toFixed(2)).toBe("658.49");
  });

  it("una venta en Bs a una cuenta deja un lote a su tasa; corregirla lo ajusta y borrarla lo quita", async () => {
    const bdv = (await run((tx) => listAccounts(tx, tenantId))).find((a) => a.currency === "VES");
    const created = await run((tx) =>
      createIncomeSingle(tx, {
        tenantId,
        businessDate: day,
        line: {
          method: "pago_movil",
          amount: new Decimal(8665.6),
          currency: "VES",
          accountId: bdv?.id ?? null,
        },
        description: null,
        actor: actor(),
        sourceChannel: "text",
      }),
    );
    const id = created.ids[0] as string;
    const lotOf = async () =>
      (await run((tx) => exchangeLots(tx, tenantId))).find((l) => l.source === "income");
    expect((await lotOf())?.vesAmount.toFixed(2)).toBe("8665.60");
    expect((await lotOf())?.rate.toFixed(2)).toBe("866.56");
    const [mv] = await run((tx) =>
      tx.select().from(schema.movement).where(eq(schema.movement.id, id)),
    );
    if (!mv) throw new Error("sin venta");
    const draft = await run((tx) =>
      computeAmend(tx, {
        movement: mv,
        categoryName: null,
        changes: { amount: new Decimal(4332.8) },
      }),
    );
    await run((tx) => amendMovement(tx, { tenantId, draft, actor: actor(), now }));
    expect((await lotOf())?.vesAmount.toFixed(2)).toBe("4332.80");
    await run((tx) => deleteMovement(tx, { tenantId, movementId: id, actor: actor(), now }));
    expect(await lotOf()).toBeUndefined();
  });

  it("los lotes son por cuenta: un gasto de una cuenta no toca los Bs de otra", async () => {
    const banesco = await run((tx) =>
      createAccount(tx, {
        tenantId,
        name: "Banesco",
        currency: "VES",
        kind: "bank",
        openingBalance: new Decimal(0),
        openingKnown: true,
        openingDate: day,
        actor: actor(),
        channel: "dashboard",
      }),
    );
    await run((tx) =>
      createExchangeLot(tx, {
        tenantId,
        businessDate: day,
        usd: new Decimal(10),
        ves: new Decimal(10000),
        rate: new Decimal(1000),
        actor: actor(),
        channel: "whatsapp",
        accountId: banesco.id,
      }),
    );
    const plan = await run((tx) =>
      planAllocation(tx, tenantId, new Decimal(5000), { accountId: banesco.id }),
    );
    expect(plan?.rate.toFixed(2)).toBe("1000.00");
    expect(plan?.parts.map((p) => p.source)).toEqual(["exchange"]);
    // Sin cuenta: solo los lotes de antes de las cuentas (ya adoptados, no queda ninguno).
    expect(await run((tx) => planAllocation(tx, tenantId, new Decimal(5000)))).toBeNull();
  });

  it("cambiar la cuenta de un gasto guardado devuelve sus Bs a la vieja y toma de la nueva", async () => {
    const accounts = await run((tx) => listAccounts(tx, tenantId));
    const bdv = accounts.find((a) => a.name === "Banco de Venezuela") as AccountRef;
    const banesco = accounts.find((a) => a.name === "Banesco") as AccountRef;
    const id = await run(async (tx) => {
      const plan = await planAllocation(tx, tenantId, new Decimal(2000), {
        lock: true,
        accountId: bdv.id,
      });
      const created = await createExpense(tx, {
        tenantId,
        businessDate: day,
        amount: new Decimal(2000),
        currency: "VES",
        categoryId: null,
        description: "Pan",
        sourceChannel: "text",
        actor: actor(),
        accountId: bdv.id,
      });
      await saveAllocation(tx, tenantId, created.id, plan?.parts ?? []);
      return created.id;
    });
    const remainingIn = async (accountId: string) =>
      (await run((tx) => exchangeLots(tx, tenantId)))
        .filter((l) => l.accountId === accountId)
        .reduce((s, l) => s.plus(l.vesRemaining), new Decimal(0))
        .toFixed(2);
    const bdvBefore = await remainingIn(bdv.id);
    const [mv] = await run((tx) =>
      tx.select().from(schema.movement).where(eq(schema.movement.id, id)),
    );
    if (!mv) throw new Error("sin gasto");
    const draft = await run((tx) =>
      computeAmend(tx, {
        movement: mv,
        categoryName: null,
        changes: { accountId: banesco.id, accountName: "Banesco" },
        accountName: "Banco de Venezuela",
      }),
    );
    expect(draft.changed).toContain("accountId");
    await run((tx) => amendMovement(tx, { tenantId, draft, actor: actor(), now }));
    expect(await remainingIn(bdv.id)).toBe(new Decimal(bdvBefore).plus(2000).toFixed(2));
    expect(await remainingIn(banesco.id)).toBe("8000.00");
  });

  it("editar el saldo inicial ajusta su lote; archivar la saca del total; nombres repetidos no", async () => {
    const accounts = await run((tx) => listAccounts(tx, tenantId));
    const bdv = accounts.find((a) => a.name === "Banco de Venezuela") as AccountRef;
    const opening = async () =>
      (await run((tx) => exchangeLots(tx, tenantId))).find(
        (l) => l.source === "opening" && l.accountId === bdv.id,
      );
    const before = await opening();
    await run((tx) =>
      updateAccount(tx, {
        tenantId,
        accountId: bdv.id,
        openingBalance: new Decimal(110000),
        actor: actor(),
      }),
    );
    expect((await opening())?.vesAmount.minus(before?.vesAmount ?? 0).toFixed(2)).toBe("10000.00");
    await expect(
      run((tx) =>
        createAccount(tx, {
          tenantId,
          name: "banesco",
          currency: "VES",
          kind: "bank",
          openingBalance: new Decimal(0),
          openingKnown: true,
          openingDate: day,
          actor: actor(),
          channel: "whatsapp",
        }),
      ),
    ).rejects.toMatchObject({ code: "duplicate" });
    const banesco = accounts.find((a) => a.name === "Banesco") as AccountRef;
    await run((tx) => archiveAccount(tx, { tenantId, accountId: banesco.id, actor: actor(), now }));
    expect((await run((tx) => listAccounts(tx, tenantId))).map((a) => a.name)).not.toContain(
      "Banesco",
    );
    expect(AccountError).toBeDefined();
  });
});

describe("a qué cuenta va", () => {
  const acc = (id: string, name: string, currency: "USD" | "VES", kind: AccountRef["kind"]) =>
    ({ id, name, currency, kind }) as AccountRef;
  const accounts = [
    acc("1", "Banco de Venezuela", "VES", "bank"),
    acc("2", "Banesco", "VES", "bank"),
    acc("3", "Efectivo Bs", "VES", "cash"),
    acc("4", "Binance", "USD", "crypto"),
    acc("5", "Zelle", "USD", "zelle"),
    acc("6", "Efectivo $", "USD", "cash"),
  ];
  const pick = (input: Parameters<typeof resolveAccount>[1]) =>
    resolveAccount(accounts, input)?.name ?? null;

  it("la nombrada en el mensaje, aunque sea por su apodo", () => {
    expect(pick({ currency: "VES", text: "pagué 500 bs de luz con banesco" })).toBe("Banesco");
    expect(pick({ currency: "VES", text: "pagué 500 bs con el bdv" })).toBe("Banco de Venezuela");
    // Un gasto en $ pagado desde una cuenta en Bs nombrada.
    expect(pick({ currency: "USD", text: "pagué 10$ con banesco" })).toBe("Banesco");
  });

  it("por el método o las palabras: pago móvil, efectivo, zelle, binance", () => {
    expect(pick({ currency: "VES", text: "gasté 300 bs en efectivo" })).toBe("Efectivo Bs");
    expect(pick({ currency: "USD", text: "pagué 20$ en efectivo" })).toBe("Efectivo $");
    expect(pick({ currency: "USD", text: "me pagaron 30 por zelle" })).toBe("Zelle");
    expect(pick({ currency: "USD", text: "x", method: "zelle" })).toBe("Zelle");
    expect(pick({ currency: "VES", text: "x", method: "cash_ves" })).toBe("Efectivo Bs");
  });

  it("si no dice nada, la principal de la moneda; en una corrección, los turnos anteriores", () => {
    expect(pick({ currency: "VES", text: "gasté 500 bs en pan" })).toBe("Banco de Venezuela");
    expect(pick({ currency: "USD", text: "gasté 5$ en pan" })).toBe("Binance");
    expect(pick({ currency: "VES", text: "no, eran 600", context: "500 bs con banesco" })).toBe(
      "Banesco",
    );
    expect(pick({ currency: "VES", text: "gasté 500", noFallback: true })).toBeNull();
  });

  it("gastos en $: salen del banco en Bs salvo que diga Zelle, efectivo, Binance o la cuenta (16/10)", () => {
    const usd = (text: string) => pick({ currency: "USD", text, dollarsFromBs: true });
    // Sin cuenta dicha: la principal en Bs, a la BCV; no la primera en dólares.
    expect(usd("4400 compra de brocha y batería 5$")).toBe("Banco de Venezuela");
    expect(usd("gasté 10$ en comida a tasa bcv")).toBe("Banco de Venezuela");
    // Pago móvil, punto o transferencia son de un banco en Bs.
    expect(usd("pagué 10$ por pago móvil")).toBe("Banco de Venezuela");
    expect(usd("10$ con banesco")).toBe("Banesco");
    // Lo que sí es en dólares.
    expect(usd("pagué 30$ por zelle")).toBe("Zelle");
    expect(usd("20$ en efectivo")).toBe("Efectivo $");
    expect(usd("15 usdt de binance")).toBe("Binance");
    expect(usd("10$ con el zelle")).toBe("Zelle");
    // Sin cuentas en Bs, la de dólares de siempre.
    const onlyUsd = accounts.filter((a) => a.currency === "USD");
    expect(
      resolveAccount(onlyUsd, { currency: "USD", text: "gasté 5$", dollarsFromBs: true })?.name,
    ).toBe("Binance");
  });

  it("ventas: pago móvil, punto o transferencia en Bs van al banco en Bs aunque la venta sea en $", () => {
    expect(pick({ currency: "USD", text: "x", method: "pago_movil" })).toBe("Banco de Venezuela");
    expect(pick({ currency: "USD", text: "x", method: "punto" })).toBe("Banco de Venezuela");
    expect(pick({ currency: "USD", text: "pago móvil a banesco", method: "pago_movil" })).toBe(
      "Banesco",
    );
    // Una venta en $ sin método sigue en la principal en dólares (el arreglo no es un flag).
    expect(pick({ currency: "USD", text: "vendí 20$" })).toBe("Binance");
    // Sin banco en Bs, como antes.
    const onlyUsd = accounts.filter((a) => a.currency === "USD");
    expect(resolveAccount(onlyUsd, { currency: "USD", text: "x", method: "punto" })?.name).toBe(
      "Binance",
    );
  });

  it("renglón de un desglose: manda su método, no las palabras de los otros renglones", () => {
    const text = "hoy vendí 300$: 200 efectivo, 50 zelle, 50 otra cosa";
    const line = (method: PaymentMethod | null) =>
      pick({ currency: "USD", text, method, lineOnly: true });
    expect(line("cash_usd")).toBe("Efectivo $");
    expect(line("zelle")).toBe("Zelle");
    expect(line("other")).toBe("Binance");
    expect(line(null)).toBe("Binance");
    expect(pick({ currency: "USD", text, method: "other", lineOnly: true, noFallback: true })).toBe(
      null,
    );
    expect(
      pick({
        currency: "USD",
        text: "200 efectivo, 100 pago móvil a banesco",
        method: "pago_movil",
        lineOnly: true,
      }),
    ).toBe("Banesco");
    expect(
      pick({ currency: "VES", text: "5000 en efectivo", method: "cash_ves", lineOnly: true }),
    ).toBe("Efectivo Bs");
  });

  it("un cambio no toma la cuenta de la otra moneda", () => {
    const text = "cambié 100 usdt de binance a 970 al banesco";
    expect(pick({ currency: "VES", text, strictCurrency: true, preferKind: "bank" })).toBe(
      "Banesco",
    );
    expect(pick({ currency: "USD", text, strictCurrency: true, preferKind: "crypto" })).toBe(
      "Binance",
    );
    expect(namedAccount(accounts, "nada que ver")).toBeNull();
  });
});

/**
 * Crear una cuenta sin saldo dicho no borra Bs (PRD cash-in-drawer, US-013): los cambios de antes
 * de las cuentas pasan enteros y su suma es el saldo inicial; el efectivo nunca los adopta.
 */
describe("cuentas: saldo no dicho y lotes de antes", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  let phoneId: string;
  const day = asIsoDate("2026-10-04");
  const run = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(t.db, tenantId, fn);

  beforeAll(async () => {
    t = await createTestDb();
    await t.db
      .insert(schema.bcvRate)
      .values({ effectiveDate: "2026-10-02", rate: "866.56000000", source: "test" });
  });
  afterAll(() => t.close());

  /** Un registro nuevo con dos cambios viejos sin cuenta: quedan Bs 30.000 y Bs 10.000. */
  async function freshTenant() {
    tenantId = await seedTenant(t.db, {
      name: `Lotes ${Math.random()}`,
      businessType: "car_wash",
      ownerPhone: `58412${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
    });
    phoneId = (await run((tx) => tx.select().from(schema.phoneNumber)))[0]?.id ?? "";
    for (const left of ["30000.00", "10000.00"])
      await run(async (tx) => {
        const lotId = await createExchangeLot(tx, {
          tenantId,
          businessDate: "2026-10-01",
          usd: new Decimal(50),
          ves: new Decimal(48500),
          rate: new Decimal(970),
          actor: { phoneId },
          channel: "whatsapp",
        });
        await tx
          .update(schema.exchangeLot)
          .set({ vesRemaining: left })
          .where(eq(schema.exchangeLot.id, lotId));
      });
  }

  const create = (
    name: string,
    kind: AccountRef["kind"],
    opening: string | null,
    channel: "whatsapp" | "dashboard" = "whatsapp",
  ) =>
    run((tx) =>
      createAccount(tx, {
        tenantId,
        name,
        currency: "VES",
        kind,
        openingBalance: new Decimal(opening ?? 0),
        openingKnown: opening !== null,
        openingDate: day,
        actor: { phoneId },
        channel,
      }),
    );
  const lots = () =>
    run((tx) =>
      tx
        .select()
        .from(schema.exchangeLot)
        .where(
          and(eq(schema.exchangeLot.tenantId, tenantId), eq(schema.exchangeLot.source, "exchange")),
        )
        .orderBy(schema.exchangeLot.vesRemaining),
    );
  const balanceOf = async (name: string) =>
    (await run((tx) => accountBalances(tx, tenantId)))
      .find((a) => a.name === name)
      ?.balance.toFixed(2);

  it("un gasto sin cuenta sigue tomando Bs de los lotes sin cuenta (chequeo previo)", async () => {
    await freshTenant();
    const plan = await run((tx) => planAllocation(tx, tenantId, new Decimal(5000)));
    expect(plan?.parts.map((p) => p.source)).toEqual(["exchange"]);
  });

  it("un registro con lotes vivos conserva su ves_remaining: 'crea la cuenta Banesco' sin saldo", async () => {
    await freshTenant();
    const banesco = await create("Banesco", "bank", null);
    const after = await lots();
    expect(after.map((l) => [l.accountId, l.vesRemaining])).toEqual([
      [banesco.id, "10000.00"],
      [banesco.id, "30000.00"],
    ]);
    expect(await balanceOf("Banesco")).toBe("40000.00");
    const [row] = await run((tx) =>
      tx.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, banesco.id)),
    );
    expect((row?.after as { openingBalance?: string } | undefined)?.openingBalance).toBe(
      "40000.00",
    );
  });

  it("lo mismo desde Ajustes con el campo de saldo vacío", async () => {
    await freshTenant();
    await create("Banesco", "bank", null, "dashboard");
    expect(await balanceOf("Banesco")).toBe("40000.00");
  });

  it("con saldo dicho, como antes: se recorta a ese saldo", async () => {
    await freshTenant();
    await create("Banesco", "bank", "25000");
    expect(await balanceOf("Banesco")).toBe("25000.00");
    // Se recorta del cambio más viejo (el de 30.000), como siempre.
    expect((await lots()).map((l) => l.vesRemaining)).toEqual(["10000.00", "15000.00"]);
  });

  it("el efectivo no adopta los lotes; la cuenta de banco que viene después sí", async () => {
    await freshTenant();
    await create("Efectivo Bs", "cash", null);
    expect(await balanceOf("Efectivo Bs")).toBe("0.00");
    expect((await lots()).map((l) => [l.accountId, l.vesRemaining])).toEqual([
      [null, "10000.00"],
      [null, "30000.00"],
    ]);
    await create("Banesco", "bank", null);
    expect(await balanceOf("Banesco")).toBe("40000.00");
    expect(await balanceOf("Efectivo Bs")).toBe("0.00");
  });

  it("efectivo con el conteo: empieza con lo contado y los lotes quedan igual", async () => {
    await freshTenant();
    await create("Efectivo Bs", "cash", "15000");
    expect(await balanceOf("Efectivo Bs")).toBe("15000.00");
    expect((await lots()).map((l) => [l.accountId, l.vesRemaining])).toEqual([
      [null, "10000.00"],
      [null, "30000.00"],
    ]);
  });
});
