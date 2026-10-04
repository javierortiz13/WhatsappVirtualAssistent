import { eq, isNull, schema, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asIsoDate } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";
import {
  type AccountRef,
  accountBalances,
  accountStatement,
  createAccount,
} from "../src/ledger/accounts";
import { createExchangeLot, exchangeLots } from "../src/ledger/exchange";
import {
  createTransfer,
  deleteTransfer,
  TransferError,
  transferAmounts,
} from "../src/ledger/transfers";

/** Transferencias entre cuentas (0014): misma moneda, Bs → USDT, comisión, borrar y extracto. */
describe("transferencias entre cuentas", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  let phoneId: string;
  const now = new Date("2026-10-04T15:00:00Z");
  const day = asIsoDate("2026-10-04");
  const actor = () => ({ phoneId });
  const run = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(t.db, tenantId, fn);
  const acc: Record<string, AccountRef> = {};

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
    for (const [name, currency, kind, opening] of [
      ["BDV", "VES", "bank", "0"],
      ["Banesco", "VES", "bank", "0"],
      ["Zelle", "USD", "zelle", "500"],
      ["Binance", "USD", "crypto", "0"],
    ] as const)
      acc[name] = await run((tx) =>
        createAccount(tx, {
          tenantId,
          name,
          currency,
          kind,
          openingBalance: new Decimal(opening),
          openingDate: day,
          actor: actor(),
          channel: "dashboard",
        }),
      );
    // Bs 97.000 en el BDV que costaron $100 (cambio a 970).
    await run((tx) =>
      createExchangeLot(tx, {
        tenantId,
        businessDate: day,
        usd: new Decimal(100),
        ves: new Decimal(97000),
        rate: new Decimal(970),
        actor: actor(),
        channel: "whatsapp",
        accountId: acc.BDV?.id ?? null,
        fromAccountId: acc.Binance?.id ?? null,
      }),
    );
  });
  afterAll(() => t.close());

  const balances = async () =>
    Object.fromEntries(
      (await run((tx) => accountBalances(tx, tenantId))).map((a) => [a.name, a.balance.toFixed(2)]),
    );
  const id = (name: string) => acc[name]?.id as string;

  it("completa los montos según las monedas", () => {
    const d = (v: string | null) => (v ? new Decimal(v) : null);
    const USD = { currency: "USD" as const };
    const VES = { currency: "VES" as const };
    expect(transferAmounts(USD, USD, { fromAmount: d("100"), toAmount: null, rate: null })).toEqual(
      {
        fromAmount: new Decimal(100),
        toAmount: new Decimal(100),
      },
    );
    expect(
      transferAmounts(VES, USD, { fromAmount: d("49000"), toAmount: null, rate: d("980") }),
    ).toEqual({ fromAmount: new Decimal(49000), toAmount: new Decimal(50) });
    expect(transferAmounts(USD, VES, { fromAmount: d("10"), toAmount: null, rate: null })).toBe(
      "use_exchange",
    );
    expect(transferAmounts(VES, USD, { fromAmount: d("49000"), toAmount: null, rate: null })).toBe(
      null,
    );
  });

  it("misma moneda con comisión: llega lo enviado y la comisión es un gasto de la de origen", async () => {
    const r = await run((tx) =>
      createTransfer(tx, {
        tenantId,
        fromAccountId: id("Zelle"),
        toAccountId: id("Binance"),
        fromAmount: new Decimal(99),
        toAmount: new Decimal(99),
        fee: new Decimal(1),
        businessDate: day,
        description: null,
        actor: actor(),
        channel: "whatsapp",
      }),
    );
    expect(await balances()).toMatchObject({ Zelle: "400.00", Binance: "-1.00" });
    const [fee] = await run((tx) =>
      tx
        .select()
        .from(schema.movement)
        .where(eq(schema.movement.id, r.feeMovementId as string)),
    );
    expect(fee).toMatchObject({ type: "expense", amount: "1.00", accountId: id("Zelle") });
    expect(fee?.description).toBe("Comisión Zelle → Binance");
  });

  it("entre cuentas en Bs, los bolívares se llevan su costo", async () => {
    await run((tx) =>
      createTransfer(tx, {
        tenantId,
        fromAccountId: id("BDV"),
        toAccountId: id("Banesco"),
        fromAmount: new Decimal(9700),
        toAmount: new Decimal(9700),
        fee: null,
        businessDate: day,
        description: null,
        actor: actor(),
        channel: "dashboard",
      }),
    );
    expect(await balances()).toMatchObject({ BDV: "87300.00", Banesco: "9700.00" });
    const lots = await run((tx) => exchangeLots(tx, tenantId));
    const banesco = lots.find((l) => l.accountId === id("Banesco"));
    expect(banesco).toMatchObject({ source: "transfer" });
    expect(banesco?.rate.toFixed(2)).toBe("970.00");
    expect(lots.find((l) => l.accountId === id("BDV"))?.vesRemaining.toFixed(2)).toBe("87300.00");
  });

  it("comprar USDT con Bs: sale de los lotes del banco y entra en Binance", async () => {
    await run((tx) =>
      createTransfer(tx, {
        tenantId,
        fromAccountId: id("BDV"),
        toAccountId: id("Binance"),
        fromAmount: new Decimal(48500),
        toAmount: new Decimal(49),
        fee: null,
        businessDate: day,
        description: null,
        actor: actor(),
        channel: "whatsapp",
      }),
    );
    expect(await balances()).toMatchObject({ BDV: "38800.00", Binance: "48.00" });
    expect(
      (await run((tx) => exchangeLots(tx, tenantId)))
        .find((l) => l.accountId === id("BDV"))
        ?.vesRemaining.toFixed(2),
    ).toBe("38800.00");
  });

  it("dólares → Bs no es transferencia sino cambio; la misma cuenta tampoco", async () => {
    const base = {
      tenantId,
      fromAmount: new Decimal(10),
      toAmount: new Decimal(10),
      fee: null,
      businessDate: day,
      description: null,
      actor: actor(),
      channel: "whatsapp" as const,
    };
    await expect(
      run((tx) =>
        createTransfer(tx, { ...base, fromAccountId: id("Zelle"), toAccountId: id("BDV") }),
      ),
    ).rejects.toMatchObject({ code: "use_exchange" });
    await expect(
      run((tx) =>
        createTransfer(tx, { ...base, fromAccountId: id("Zelle"), toAccountId: id("Zelle") }),
      ),
    ).rejects.toBeInstanceOf(TransferError);
  });

  it("el estado de cuenta lleva el saldo después de cada línea", async () => {
    const st = await run((tx) => accountStatement(tx, tenantId, id("BDV"), { from: day, to: day }));
    expect(
      st?.entries.map((e) => [e.kind, e.amount.toFixed(2), e.balanceAfter.toFixed(2)]),
    ).toEqual([
      ["transfer_out", "-48500.00", "38800.00"],
      ["transfer_out", "-9700.00", "87300.00"],
      ["exchange_in", "97000.00", "97000.00"],
      ["opening", "0.00", "0.00"],
    ]);
    expect(st?.entries[0]?.label).toBe("Binance");
    expect(st?.entries[0]?.usd?.toFixed(2)).toBe("49.00");
    expect(st?.period.in.toFixed(2)).toBe("97000.00");
    expect(st?.period.out.toFixed(2)).toBe("58200.00");
  });

  it("borrar una transferencia devuelve los Bs y quita la comisión", async () => {
    const zelle = await run((tx) =>
      tx
        .select()
        .from(schema.accountTransfer)
        .where(eq(schema.accountTransfer.fromAccountId, id("Zelle"))),
    );
    await run((tx) =>
      deleteTransfer(tx, { tenantId, transferId: zelle[0]?.id as string, actor: actor(), now }),
    );
    expect(await balances()).toMatchObject({ Zelle: "500.00", Binance: "-51.00" });
    const fees = await run((tx) =>
      tx.select().from(schema.movement).where(isNull(schema.movement.deletedAt)),
    );
    expect(fees).toHaveLength(0);
    const toBanesco = await run((tx) =>
      tx
        .select()
        .from(schema.accountTransfer)
        .where(eq(schema.accountTransfer.toAccountId, id("Banesco"))),
    );
    await run((tx) =>
      deleteTransfer(tx, { tenantId, transferId: toBanesco[0]?.id as string, actor: actor(), now }),
    );
    expect(await balances()).toMatchObject({ BDV: "48500.00", Banesco: "0.00" });
    const lots = await run((tx) => exchangeLots(tx, tenantId));
    expect(lots.find((l) => l.accountId === id("Banesco"))).toBeUndefined();
  });
});
