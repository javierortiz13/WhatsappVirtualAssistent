import { randomUUID } from "node:crypto";
import { eq, schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import { lateCode, referralCodeFor, storePendingRef } from "../src/billing/referrals";
import { trialMessageCap } from "../src/billing/trial";
import { businessDateOf } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";
import { ingestWebhook } from "../src/inbox/ingest";
import { type ProcessDeps, processInbound } from "../src/inbox/process";
import { saveHabitSettings } from "../src/ledger/habits";
import { registerBusiness } from "../src/onboarding/register";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/**
 * Seguridad P4, F1: en el registro web, la invitación se une y da el +50 recién cuando el dueño
 * verifica su número por WhatsApp, nunca antes. Antes de verificar, los dos caminos (un número
 * que ya usó Rocco y uno nuevo) se ven igual: tope 100, sin fila `referral` y nada reservado.
 */
const DAY = 86_400_000;

const llm: LlmClient = {
  model: "fake",
  async complete() {
    return {
      toolCalls: [{ id: "x", name: "ask_clarification", input: { question: "¿Cuánto fue?" } }],
      text: null,
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: "fake",
    };
  },
  costUsd: () => new Decimal(0),
};

function fakeMeta() {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ messages: [{ id: `wamid.OUT.${Math.random()}` }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  return new MetaClient({ accessToken: "T", phoneNumberId: fx.PHONE_NUMBER_ID, fetchImpl });
}

describe("invitación del registro web (seguridad F1)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let code: string;
  let n = 0;
  let seq = 0;
  const now = () => new Date();

  beforeAll(async () => {
    t = await createTestDb();
    await saveHabitSettings(t.db, { xp: true, rewards: true, referrals: true }, "test", now());
    await t.db
      .insert(schema.bcvRate)
      .values({ effectiveDate: businessDateOf(now()), rate: "200.00000000", source: "test" });
    // Quien invita: 3 días con registro y su código.
    const inviterId = await seedTenant(t.db, {
      name: "Quien invita",
      businessType: "retail",
      ownerPhone: "584140000001",
    });
    await withTenant(t.db, inviterId, async (tx) => {
      const [p] = await tx.select().from(schema.phoneNumber);
      for (const d of [1, 2, 3]) {
        const at = new Date(Date.now() - d * DAY);
        await tx.insert(schema.movement).values({
          tenantId: inviterId,
          type: "expense",
          amount: "1.00",
          currency: "USD",
          amountUsd: "1.00",
          amountVes: "200.00",
          rateValue: "200.00000000",
          rateSource: "manual",
          businessDate: businessDateOf(at),
          paymentMethod: "unspecified",
          origin: "single",
          sourceChannel: "text",
          createdByPhoneId: p?.id ?? "",
          createdAt: at,
        });
      }
    });
    code = (await withTenant(t.db, inviterId, (tx) => referralCodeFor(tx, inviterId))) as string;
  });
  afterAll(() => t.close());

  function deps(): ProcessDeps {
    return {
      db: t.db,
      metaFor: () => fakeMeta(),
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
    };
  }

  /** El dueño manda el código de vinculación desde su WhatsApp. */
  async function verify(from: string, body: string) {
    const jobs: ProcessMessageJob[] = [];
    const p = JSON.parse(JSON.stringify(fx.textMessage(`wamid.RW${++seq}`, body)));
    const value = p.entry[0].changes[0].value;
    value.contacts[0] = { profile: { name: "Prueba" }, wa_id: from };
    value.messages[0].from = from;
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    return processInbound(deps(), jobs[0] as ProcessMessageJob);
  }

  /** El asistente web: la cuenta con el número sin verificar y el código escrito en el campo. */
  async function webSignup(phone: string) {
    const userId = randomUUID();
    await t.db.insert(schema.userAccount).values({ id: userId, email: `p${++n}@ejemplo.com` });
    const r = await registerBusiness(t.db, {
      userId,
      name: "Negocio",
      businessType: "retail",
      defaultExpenseCurrency: "USD",
      ownerPhone: phone,
    });
    await withTenant(t.db, r.tenantId, (tx) => storePendingRef(tx, r.tenantId, code));
    return r;
  }
  const tenantRow = async (id: string) =>
    (
      await withTenant(t.db, id, (tx) =>
        tx.select().from(schema.tenant).where(eq(schema.tenant.id, id)),
      )
    )[0] as typeof schema.tenant.$inferSelect;
  const referralOf = async (inviteeId: string) =>
    t.db.select().from(schema.referral).where(eq(schema.referral.inviteeTenantId, inviteeId));

  it("antes de verificar: tope 100, sin invitación y nada reservado, en los dos caminos", async () => {
    // Un número que ya le escribió a Rocco (registro por chat sin terminar) y uno nuevo.
    const returningPhone = "584240000101";
    const freshPhone = "584240000102";
    await t.db.insert(schema.signup).values({ e164: returningPhone, step: "name", data: {} });
    const returning = await webSignup(returningPhone);
    const fresh = await webSignup(freshPhone);

    for (const r of [returning, fresh]) {
      const row = await tenantRow(r.tenantId);
      expect(trialMessageCap(row)).toBe(100);
      expect(row.pendingRefCode).toBe(code);
      expect(await referralOf(r.tenantId)).toEqual([]);
    }
    expect(await t.db.select().from(schema.rewardMonth)).toEqual([]);
    expect(await t.db.select().from(schema.referralMonth)).toEqual([]);
    expect(await t.db.select().from(schema.rewardGrant)).toEqual([]);

    // Verifica desde ese número: el que ya usó Rocco queda «returning» (100); el nuevo, 150.
    expect(await verify(returningPhone, returning.code)).toBe("done");
    expect(await verify(freshPhone, fresh.code)).toBe("done");
    const [rr] = await referralOf(returning.tenantId);
    expect([rr?.via, rr?.endReason]).toEqual(["web", "returning"]);
    expect(trialMessageCap(await tenantRow(returning.tenantId))).toBe(100);
    const [rf] = await referralOf(fresh.tenantId);
    expect([rf?.via, rf?.stage, rf?.endReason]).toEqual(["web", "signed_up", null]);
    expect(trialMessageCap(await tenantRow(fresh.tenantId))).toBe(150);
    // El código ya no espera en ninguna de las dos cuentas.
    expect((await tenantRow(returning.tenantId)).pendingRefCode).toBeNull();
    expect((await tenantRow(fresh.tenantId)).pendingRefCode).toBeNull();
    // F2: el $1,05 del +50 va al contador de invitados, no al tope de los regalos.
    expect(await t.db.select().from(schema.rewardMonth)).toEqual([]);
    const months = await t.db.select().from(schema.referralMonth);
    expect(months.map((m) => m.bookedUsd)).toEqual(["1.05"]);
  });

  it("con `referrals` apagado al verificar: no se une y el código se borra", async () => {
    const r = await webSignup("584240000103");
    await saveHabitSettings(t.db, { referrals: false }, "test", now());
    try {
      expect(await verify("584240000103", r.code)).toBe("done");
    } finally {
      await saveHabitSettings(t.db, { referrals: true }, "test", now());
    }
    expect(await referralOf(r.tenantId)).toEqual([]);
    const row = await tenantRow(r.tenantId);
    expect([trialMessageCap(row), row.pendingRefCode]).toEqual([100, null]);
  });

  /**
   * V-1 (re-revisión de fdae0ce): un número que el dueño agregó como empleado y que nunca escribió
   * no decide si el negocio «ya usó Rocco»; si no, cualquiera podría saber si un número ajeno usó
   * Rocco. Uno que sí escribió y quedó verificado, sí cuenta.
   */
  const OTHER_PHONE = "584240000201";
  /** Un número que ya le escribió a Rocco (registro por chat sin terminar, o vaciado con marca). */
  async function phoneWithHistory(e164: string) {
    await t.db.insert(schema.signup).values({ e164, step: "name", data: {} });
  }
  async function addEmployee(tenantId: string, e164: string, verified: boolean) {
    await withTenant(t.db, tenantId, (tx) =>
      tx.insert(schema.phoneNumber).values({
        tenantId,
        e164,
        role: "employee",
        status: "active",
        verifiedAt: verified ? new Date() : null,
      }),
    );
  }

  it("V-1: un empleado sin verificar con historia en Rocco no cuenta → attached, 150", async () => {
    await phoneWithHistory(OTHER_PHONE);
    const r = await webSignup("584240000202");
    await addEmployee(r.tenantId, OTHER_PHONE, false);
    expect(await verify("584240000202", r.code)).toBe("done");
    const [ref] = await referralOf(r.tenantId);
    expect([ref?.stage, ref?.endReason]).toEqual(["signed_up", null]);
    expect(trialMessageCap(await tenantRow(r.tenantId))).toBe(150);
  });

  it("V-1: un empleado que escribió y está verificado sí cuenta → returning", async () => {
    await phoneWithHistory("584240000203");
    const r = await webSignup("584240000204");
    await addEmployee(r.tenantId, "584240000203", true);
    expect(await verify("584240000204", r.code)).toBe("done");
    const [ref] = await referralOf(r.tenantId);
    expect([ref?.stage, ref?.endReason]).toEqual(["ended", "returning"]);
    expect(trialMessageCap(await tenantRow(r.tenantId))).toBe(100);
  });

  it("V-1: «me invitó CODE» con un empleado sin verificar con historia → attached", async () => {
    await phoneWithHistory("584240000205");
    const owner = await seedTenant(t.db, {
      name: "Por chat",
      businessType: "retail",
      ownerPhone: "584240000206",
    });
    await addEmployee(owner, "584240000205", false);
    const out = await withTenant(t.db, owner, (tx) =>
      lateCode(tx, owner, `me invitó ${code}`, now()),
    );
    expect(out.kind).toBe("attached");
    const [ref] = await referralOf(owner);
    expect([ref?.via, ref?.stage, ref?.endReason]).toEqual(["late", "signed_up", null]);
  });

  it("V-2: si la unión falla, el número queda activo, sin invitación y el código no vuelve", async () => {
    const r = await webSignup("584240000207");
    await t.pg.exec("ALTER FUNCTION app.attach_referral(text, text) RENAME TO attach_referral_v2");
    try {
      expect(await verify("584240000207", r.code)).toBe("done");
    } finally {
      await t.pg.exec(
        "ALTER FUNCTION app.attach_referral_v2(text, text) RENAME TO attach_referral",
      );
    }
    const [phone] = await withTenant(t.db, r.tenantId, (tx) =>
      tx.select().from(schema.phoneNumber).where(eq(schema.phoneNumber.tenantId, r.tenantId)),
    );
    expect([phone?.status, phone?.verifiedAt instanceof Date]).toEqual(["active", true]);
    expect(await referralOf(r.tenantId)).toEqual([]);
    const row = await tenantRow(r.tenantId);
    expect([trialMessageCap(row), row.pendingRefCode]).toEqual([100, null]);
  });

  it("un código sin la forma no se guarda", async () => {
    const userId = randomUUID();
    await t.db.insert(schema.userAccount).values({ id: userId, email: "x@ejemplo.com" });
    const r = await registerBusiness(t.db, {
      userId,
      name: "Otro",
      businessType: "retail",
      defaultExpenseCurrency: "USD",
      ownerPhone: "584240000104",
    });
    await withTenant(t.db, r.tenantId, (tx) => storePendingRef(tx, r.tenantId, "RK4M7O"));
    expect((await tenantRow(r.tenantId)).pendingRefCode).toBeNull();
  });
});
