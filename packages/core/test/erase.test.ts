import { eq, rows, schema, sql, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asIsoDate } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";
import { type AccountRef, createAccount } from "../src/ledger/accounts";
import { createExchangeLot } from "../src/ledger/exchange";
import { createExpense } from "../src/ledger/expenses";
import { createTransfer } from "../src/ledger/transfers";
import { cleanupErased, eraseTenant } from "../src/onboarding/erase";
import { MemoryObjectStore } from "../src/storage/index";

/** Eliminar un negocio por completo (0017): todo lo suyo se va, lo de los demás queda. */
describe("eliminar un negocio", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let gone: string;
  let kept: string;
  const day = asIsoDate("2026-10-04");
  const userId = "44444444-4444-4444-8444-444444444444";
  const sharedUser = "55555555-5555-4555-8555-555555555555";

  async function fill(tenantId: string, phone: string) {
    const run = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(t.db, tenantId, fn);
    // Las pruebas corren como superusuario (sin RLS): filtrar por negocio.
    const [p] = await run((tx) =>
      tx.select().from(schema.phoneNumber).where(eq(schema.phoneNumber.tenantId, tenantId)),
    );
    const actor = { phoneId: p?.id ?? "" };
    const acc: Record<string, AccountRef> = {};
    for (const [name, currency, kind] of [
      ["BDV", "VES", "bank"],
      ["Banesco", "VES", "bank"],
      ["Binance", "USD", "crypto"],
    ] as const)
      acc[name] = await run((tx) =>
        createAccount(tx, {
          tenantId,
          name,
          currency,
          kind,
          openingBalance: new Decimal(name === "Binance" ? 200 : 0),
          openingDate: day,
          actor,
          channel: "dashboard",
        }),
      );
    await run(async (tx) => {
      await createExchangeLot(tx, {
        tenantId,
        businessDate: day,
        usd: new Decimal(100),
        ves: new Decimal(97000),
        rate: new Decimal(970),
        actor,
        channel: "whatsapp",
        accountId: acc.BDV?.id ?? null,
        fromAccountId: acc.Binance?.id ?? null,
      });
      await createTransfer(tx, {
        tenantId,
        fromAccountId: acc.BDV?.id ?? "",
        toAccountId: acc.Banesco?.id ?? "",
        fromAmount: new Decimal(9700),
        toAmount: new Decimal(9700),
        fee: new Decimal(30),
        businessDate: day,
        description: null,
        actor,
        channel: "whatsapp",
      });
      await createExpense(tx, {
        tenantId,
        businessDate: day,
        amount: new Decimal(15),
        currency: "USD",
        categoryId: null,
        description: "Champú",
        sourceChannel: "text",
        actor,
      });
      const [ev] = await tx
        .insert(schema.webhookEvent)
        .values({ eventKey: `ev-${phone}`, payload: { sender: { e164: phone }, text: "hola" } })
        .returning();
      await tx.insert(schema.message).values({
        tenantId,
        phoneId: actor.phoneId,
        direction: "in",
        kind: "text",
        body: "gasté 15$",
        webhookEventId: ev?.id ?? null,
      });
      await tx.insert(schema.attachment).values({
        tenantId,
        kind: "receipt",
        storageKey: `${tenantId}/foto.jpg`,
        mimeType: "image/jpeg",
        sizeBytes: 10,
      });
    });
  }

  beforeAll(async () => {
    t = await createTestDb();
    await t.db
      .insert(schema.bcvRate)
      .values({ effectiveDate: "2026-10-02", rate: "866.56000000", source: "test" });
    gone = await seedTenant(t.db, {
      name: "Se va",
      businessType: "food",
      ownerPhone: "584127806000",
    });
    kept = await seedTenant(t.db, {
      name: "Se queda",
      businessType: "food",
      ownerPhone: "584120000009",
    });
    await fill(gone, "584127806000");
    await fill(kept, "584120000009");
    await t.db.insert(schema.userAccount).values([
      { id: userId, email: "solo@test" },
      { id: sharedUser, email: "dos@test" },
    ]);
    for (const [tenantId, user] of [
      [gone, userId],
      [gone, sharedUser],
      [kept, sharedUser],
    ] as const)
      await withTenant(t.db, tenantId, (tx) =>
        tx.insert(schema.tenantMember).values({ tenantId, userId: user, role: "owner" }),
      );
    await t.db.insert(schema.unknownSenderHit).values({ e164: "584127806000", hits: 1 });
  });
  afterAll(() => t.close());

  const count = async (table: string, tenantId: string) => {
    const r = rows<{ n: number }>(
      await t.db.execute(
        sql.raw(`select count(*)::int as n from app.${table} where tenant_id = '${tenantId}'`),
      ),
    );
    return Number(r[0]?.n ?? 0);
  };

  it("solo borra el negocio fijado con withTenant", async () => {
    const err = await withTenant(t.db, kept, (tx) => eraseTenant(tx, gone)).catch((e) => e);
    expect(String(err?.cause?.message ?? err)).toMatch(/no coincide/);
  });

  it("borra todo lo del negocio y devuelve fotos y usuarios huérfanos", async () => {
    const tables = [
      "movement",
      "account",
      "account_transfer",
      "exchange_lot",
      "exchange_allocation",
      "message",
      "attachment",
      "category",
      "phone_number",
      "tenant_member",
      "audit_log",
    ];
    const before = Object.fromEntries(
      await Promise.all(tables.map(async (x) => [x, await count(x, kept)] as const)),
    );
    expect(before.movement).toBeGreaterThan(0);
    expect(before.account_transfer).toBe(1);

    const erased = await withTenant(t.db, gone, (tx) => eraseTenant(tx, gone));
    expect(erased.storageKeys).toEqual([`${gone}/foto.jpg`]);
    // El que también es miembro de otro negocio se queda.
    expect(erased.orphanUserIds).toEqual([userId]);

    for (const x of tables) expect(await count(x, gone), x).toBe(0);
    const [tenantRow] = await t.db.select().from(schema.tenant).where(eq(schema.tenant.id, gone));
    expect(tenantRow).toBeUndefined();
    const users = await t.db.select().from(schema.userAccount);
    expect(users.map((u) => u.id)).toEqual([sharedUser]);
    const events = await t.db.select().from(schema.webhookEvent);
    expect(events.map((e) => e.eventKey)).toEqual(["ev-584120000009"]);
    expect(await t.db.select().from(schema.unknownSenderHit)).toEqual([]);

    // El otro negocio, intacto.
    for (const x of tables) expect(await count(x, kept), x).toBe(before[x]);

    const store = new MemoryObjectStore();
    await store.put(`${gone}/foto.jpg`, new Uint8Array([1]), "image/jpeg");
    const deleted: string[] = [];
    const out = await cleanupErased(erased, {
      store,
      auth: { deleteUser: async (id) => void deleted.push(id) },
    });
    expect(out).toEqual({ files: 1, users: 1, failed: 0 });
    expect(store.objects.size).toBe(0);
    expect(deleted).toEqual([userId]);
  });
});
