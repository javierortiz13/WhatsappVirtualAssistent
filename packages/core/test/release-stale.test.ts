import { randomUUID } from "node:crypto";
import { eq, schema, sql, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import { asIsoDate } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";
import { resolveSender } from "../src/identity/resolve";
import { ingestWebhook } from "../src/inbox/ingest";
import { processInbound } from "../src/inbox/process";
import { createExpense } from "../src/ledger/expenses";
import { releaseStalePending } from "../src/onboarding/erase";
import { PhoneTakenError, registerBusiness } from "../src/onboarding/register";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/** Seguridad F2 (0027): un número registrado en el panel y sin verificar queda libre a las 48 h. */
const SQUATTER = randomUUID();
const REAL = randomUUID();
const OTHER = randomUUID();

const llm: LlmClient = {
  model: "fake",
  async complete() {
    return {
      toolCalls: [],
      text: "ok",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: "fake",
    };
  },
  costUsd: () => new Decimal(0),
};

describe("números pendientes viejos (F2)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  const register = (userId: string, ownerPhone: string) =>
    registerBusiness(t.db, {
      userId,
      name: "Negocio",
      businessType: "retail",
      defaultExpenseCurrency: "USD",
      ownerPhone,
    });
  /** Envejece el número: `release_stale_pending` compara con la hora de la base. */
  const age = (e164: string, hours: number) =>
    t.db.execute(
      sql`update app.phone_number set created_at = now() - ${`${hours} hours`}::interval where e164 = ${e164}`,
    );
  const tenantOf = async (e164: string) =>
    (await t.db.select().from(schema.phoneNumber).where(eq(schema.phoneNumber.e164, e164)))[0]
      ?.tenantId;

  beforeAll(async () => {
    t = await createTestDb();
    await t.db.insert(schema.userAccount).values([
      { id: SQUATTER, email: "otro@ejemplo.com" },
      { id: REAL, email: "dueno@ejemplo.com" },
      { id: OTHER, email: "tercero@ejemplo.com" },
    ]);
    await t.db
      .insert(schema.bcvRate)
      .values({ effectiveDate: "2026-10-01", rate: "858.00000000", source: "test" });
  });
  afterAll(() => t.close());

  it("antes de 48 h sigue ocupado; después, el dueño real lo registra y el negocio vacío se va", async () => {
    const first = await register(SQUATTER, "584121110001");
    await age("584121110001", 47);
    await expect(register(REAL, "584121110001")).rejects.toBeInstanceOf(PhoneTakenError);
    await age("584121110001", 49);
    const second = await register(REAL, "584121110001");
    expect(await tenantOf("584121110001")).toBe(second.tenantId);
    expect(
      await t.db.select().from(schema.tenant).where(eq(schema.tenant.id, first.tenantId)),
    ).toEqual([]);
    // El usuario del panel que lo había registrado queda sin negocio y se borra.
    expect(
      await t.db.select().from(schema.userAccount).where(eq(schema.userAccount.id, SQUATTER)),
    ).toEqual([]);
  });

  it("no toca un negocio que ya tiene movimientos", async () => {
    const withData = await register(OTHER, "584121110002");
    await withTenant(t.db, withData.tenantId, (tx) =>
      createExpense(tx, {
        tenantId: withData.tenantId,
        businessDate: asIsoDate("2026-10-01"),
        amount: new Decimal(5),
        currency: "USD",
        categoryId: null,
        description: "x",
        sourceChannel: "text",
        actor: { userId: OTHER },
      }),
    );
    await age("584121110002", 72);
    expect(await releaseStalePending(t.db)).toEqual([]);
    expect(await tenantOf("584121110002")).toBe(withData.tenantId);
  });

  it("housekeeping: libera todos los viejos y devuelve los usuarios huérfanos", async () => {
    const u = randomUUID();
    await t.db.insert(schema.userAccount).values({ id: u, email: "cuarto@ejemplo.com" });
    const r = await register(u, "584121110003");
    await age("584121110003", 49);
    const out = await releaseStalePending(t.db);
    expect(out).toEqual([{ tenantId: r.tenantId, storageKeys: [], orphanUserIds: [u] }]);
    expect(await tenantOf("584121110003")).toBeUndefined();
  });

  it("el bot: el dueño real que escribe después de 48 h ya no ve el número como pendiente", async () => {
    const u = randomUUID();
    await t.db.insert(schema.userAccount).values({ id: u, email: "quinto@ejemplo.com" });
    const r = await register(u, "584121110004");
    await age("584121110004", 49);
    const jobs: ProcessMessageJob[] = [];
    const now = () => new Date();
    const p = JSON.parse(JSON.stringify(fx.textMessage("wamid.F2", "hola")));
    const value = p.entry[0].changes[0].value;
    value.contacts[0] = { profile: { name: "Ana" }, wa_id: "584121110004" };
    value.messages[0].from = "584121110004";
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const client = new MetaClient({
      accessToken: "T",
      phoneNumberId: fx.PHONE_NUMBER_ID,
      fetchImpl,
    });
    await processInbound(
      {
        db: t.db,
        metaFor: () => client,
        agent: createAgent({ llm, now }),
        now,
        config: {
          assistantName: "Rocco",
          dashboardUrl: "https://caja.test",
          supportHint: null,
          unknownReplyMax: 5,
          unknownReplyWindowMs: 3_600_000,
          maxEventAgeMs: 12 * 3_600_000,
          maxTextLength: 500,
        },
      },
      jobs[0] as ProcessMessageJob,
    );
    expect(await t.db.select().from(schema.tenant).where(eq(schema.tenant.id, r.tenantId))).toEqual(
      [],
    );
    expect(
      await resolveSender(t.db, { e164: "584121110004", waUserId: null, displayName: null }),
    ).toBeNull();
    const [signup] = await t.db
      .select()
      .from(schema.signup)
      .where(eq(schema.signup.e164, "584121110004"));
    expect(signup?.step).toBe("name");
  });
});
