import { type Db, eq, schema, sql, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { purgeAbandonedSignups, purgeOldSenderHits } from "../src/ledger/purge";
import { canStartSignup, handleSignup } from "../src/onboarding/chat-signup";
import { eraseTenant } from "../src/onboarding/erase";
import { planSignupBatch } from "../src/onboarding/signup-batch";
import { runSignupRescue, saveSignupRescueSettings } from "../src/onboarding/signup-rescue";
import { es } from "../src/render/index";
import { MetaClient } from "../src/whatsapp/client";

/** Borrado a 90 días de los registros sin terminar (US-AD-05, 3A) y F-8. */
const DAY = 86_400_000;
const H = 3_600_000;
/** Martes 10/11/2026, 12:00 de Caracas. */
const NOW = new Date("2026-11-10T16:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const cfg = { dashboardUrl: "https://caja.test" };

function fakeMeta() {
  const sent: unknown[] = [];
  const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
    sent.push(init?.body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.P${sent.length}` }] }), {
      status: 200,
    });
  }) as typeof fetch;
  return { sent, client: new MetaClient({ accessToken: "T", phoneNumberId: "P", fetchImpl }) };
}

describe("borrado a 90 días de los registros sin terminar", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let n = 0;
  const add = async (extra: Partial<typeof schema.signup.$inferInsert> = {}) => {
    const [r] = await t.db
      .insert(schema.signup)
      .values({
        e164: `58426700${String(++n).padStart(4, "0")}`,
        step: "currency",
        data: { name: "Ana", kind: "personal" },
        messages: 4,
        profileName: "Ana Pérez",
        waUserId: `wa${n}`,
        updatedAt: ago(91),
        ...extra,
      })
      .returning();
    return r as typeof schema.signup.$inferSelect;
  };
  const get = async (id: string) =>
    (await t.db.select().from(schema.signup).where(eq(schema.signup.id, id)))[0];
  const say = (e164: string, x: { text?: string; replyId?: string }, at = NOW) =>
    handleSignup(
      t.db,
      {
        e164,
        waUserId: "wa-new",
        profileName: "Ana Nueva",
        text: x.text ?? null,
        replyId: x.replyId ?? null,
      },
      cfg,
      at,
    );

  beforeAll(async () => {
    t = await createTestDb();
    await t.db
      .insert(schema.bcvRate)
      .values({ effectiveDate: "2026-11-10", rate: "220.00000000", source: "t" });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.db.delete(schema.signup);
    await t.db.delete(schema.unknownSenderHit);
    await t.db.delete(schema.appSetting);
  });

  it("1–3: sin marcas, 91 días → borrada; 89 y exactamente 90 → intactas; rescue_via NULL a prueba de NULL", async () => {
    const old = await add();
    const recent = await add({ updatedAt: ago(89) });
    const edge = await add({ updatedAt: ago(90) });
    expect(await purgeAbandonedSignups(t.db, NOW)).toEqual({ deleted: 1, kept: 0 });
    expect(await get(old.id)).toBeUndefined();
    expect(await get(recent.id)).toBeDefined();
    expect(await get(edge.id)).toBeDefined();
  });

  it("2: completada hace 200 días → intacta; step 'done' sin completed_at → borrada", async () => {
    const done = await add({ step: "done", completedAt: ago(200), updatedAt: ago(200) });
    const taken = await add({ step: "done" });
    expect(await purgeAbandonedSignups(t.db, NOW)).toEqual({ deleted: 1, kept: 0 });
    expect(await get(done.id)).toBeDefined();
    expect(await get(taken.id)).toBeUndefined();
  });

  it("4: holdout sin otra marca y solo «Le escribí yo» → borradas enteras", async () => {
    const h = await add({ rescueVia: "holdout", rescueAt: ago(95) });
    const f = await add({ founderContactedAt: ago(95) });
    expect(await purgeAbandonedSignups(t.db, NOW)).toEqual({ deleted: 2, kept: 0 });
    expect(await get(h.id)).toBeUndefined();
    expect(await get(f.id)).toBeUndefined();
  });

  it("5: con «no me escribas» queda solo el número y la marca", async () => {
    const r = await add({ contactOffAt: ago(100), founderContactedAt: ago(95) });
    expect(await purgeAbandonedSignups(t.db, NOW)).toEqual({ deleted: 0, kept: 1 });
    expect(await get(r.id)).toMatchObject({
      e164: r.e164,
      contactOffAt: ago(100),
      data: {},
      step: "name",
      messages: 0,
      profileName: null,
      waUserId: null,
      tenantId: null,
      founderContactedAt: null,
      rescueWaMessageId: null,
      createdAt: NOW,
      updatedAt: NOW,
      purgedAt: NOW,
    });
  });

  it("6: con el mensaje de Rocco (window o template) se conserva rescue_via y rescue_at", async () => {
    const w = await add({ rescueVia: "window", rescueAt: ago(95), rescueWaMessageId: "wamid.W" });
    const b = await add({ rescueVia: "template", rescueAt: ago(92), rescueWaMessageId: "wamid.T" });
    expect(await purgeAbandonedSignups(t.db, NOW)).toEqual({ deleted: 0, kept: 2 });
    expect(await get(w.id)).toMatchObject({
      rescueVia: "window",
      rescueAt: ago(95),
      rescueWaMessageId: null,
    });
    expect(await get(b.id)).toMatchObject({ rescueVia: "template", rescueAt: ago(92) });
  });

  it("7: una segunda corrida con el mismo now no cambia nada", async () => {
    const r = await add({ contactOffAt: ago(100) });
    await add();
    await purgeAbandonedSignups(t.db, NOW);
    expect(await purgeAbandonedSignups(t.db, NOW)).toEqual({ deleted: 0, kept: 0 });
    expect((await get(r.id))?.purgedAt).toEqual(NOW);
  });

  it("8: corre como caja_app (el GRANT DELETE de 0031)", async () => {
    await add();
    await add({ contactOffAt: ago(100) });
    const out = await t.db.transaction(async (tx) => {
      await tx.execute(sql`set local role caja_app`);
      return purgeAbandonedSignups(tx as unknown as Db, NOW);
    });
    expect(out).toEqual({ deleted: 1, kept: 1 });
    // Sin el GRANT, el mismo borrado falla como caja_app: la prueba de verdad usa ese rol.
    await add();
    await expect(
      t.db.transaction(async (tx) => {
        await tx.execute(sql`revoke delete on app.signup from caja_app`);
        await tx.execute(sql`set local role caja_app`);
        await purgeAbandonedSignups(tx as unknown as Db, NOW);
      }),
    ).rejects.toThrow();
  });

  it("9: F-8 borra los contadores de más de un día, de cualquier clave", async () => {
    const old = new Date(NOW.getTime() - 2 * DAY);
    const fresh = new Date(NOW.getTime() - 10 * 60_000);
    await t.db.insert(schema.unknownSenderHit).values([
      { e164: "k:584121110000", hits: 3, windowStart: old },
      { e164: "584121110000", hits: 1, windowStart: old },
      { e164: "sig:invalid", hits: 9, windowStart: old },
      { e164: "k:584121119999", hits: 1, windowStart: fresh },
    ]);
    expect(await purgeOldSenderHits(t.db, NOW)).toBe(3);
    const left = await t.db.select().from(schema.unknownSenderHit);
    expect(left.map((r) => r.e164)).toEqual(["k:584121119999"]);
  });

  it("10, 11 y 14: vuelve tras el vaciado: presentación nueva, marca intacta, y el recordatorio no sale", async () => {
    const r = await add({ contactOffAt: ago(100) });
    await purgeAbandonedSignups(t.db, NOW);
    const back = new Date(NOW.getTime() + DAY);
    const hi = await say(r.e164, { text: "hola" }, back);
    expect(hi.outbound).toEqual([es.signupIntro(cfg.dashboardUrl, "Ana")]);
    expect(await get(r.id)).toMatchObject({
      step: "name",
      purgedAt: null,
      createdAt: back,
      contactOffAt: ago(100),
      profileName: "Ana Nueva",
    });
    await saveSignupRescueSettings(t.db, { inWindow: true, holdoutPct: 0 }, "test", ago(1));
    const m = fakeMeta();
    expect(
      (await runSignupRescue(t.db, m.client, { now: new Date(back.getTime() + 3 * H + 60_000) }))
        .sent,
    ).toBe(0);
    // 14: otra fila vaciada que vuelve diciendo «no me escribas»: SR-STOP, la marca no cambia.
    const r2 = await add({ contactOffAt: ago(120) });
    await purgeAbandonedSignups(t.db, NOW);
    expect((await say(r2.e164, { text: "no me escribas" }, back)).outbound).toEqual([
      es.signupStopped(),
    ]);
    expect((await get(r2.id))?.contactOffAt).toEqual(ago(120));
  });

  it("12: vaciada con rescue_via template: vuelve, se queda, y ni el job ni el lote la cuentan", async () => {
    const r = await add({ rescueVia: "template", rescueAt: ago(95) });
    await purgeAbandonedSignups(t.db, NOW);
    const back = new Date(NOW.getTime() + DAY);
    await say(r.e164, { text: "hola" }, back);
    await saveSignupRescueSettings(t.db, { inWindow: true, holdoutPct: 0 }, "test", ago(1));
    const m = fakeMeta();
    expect(
      (await runSignupRescue(t.db, m.client, { now: new Date(back.getTime() + 3 * H + 60_000) }))
        .sent,
    ).toBe(0);
    const plan = await planSignupBatch(t.db, { now: new Date(back.getTime() + 2 * DAY) });
    expect(plan.excluded.rescued).toBe(1);
    expect(plan.toSend).toBe(0);
  });

  it("13: vaciada con «no me escribas»; vuelve y termina: el apagado pasa a la cuenta", async () => {
    const r = await add({ contactOffAt: ago(100) });
    await purgeAbandonedSignups(t.db, NOW);
    await say(r.e164, { text: "hola" });
    await say(r.e164, { text: "Ana" });
    await say(r.e164, { replyId: "signup:kind:personal" });
    await say(r.e164, { replyId: "signup:cur:USD" });
    await say(r.e164, { replyId: "signup:cat:ok" });
    const done = await say(r.e164, { replyId: "signup:bud:skip" });
    const tenantId = done.created?.tenantId as string;
    const [phone] = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.phoneNumber).where(eq(schema.phoneNumber.e164, r.e164)),
    );
    expect(phone?.unsolicitedOffAt).not.toBeNull();
    const [a] = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.auditLog).where(eq(schema.auditLog.action, "all_off")),
    );
    expect((a?.after as { text_id?: string } | undefined)?.text_id).toBe("SR-STOP");
  });

  it("15: vaciada con template y sin opt-out; el toque viejo «No me escribas» (id o texto) apaga", async () => {
    for (const replyId of ["signup:stop", "No me escribas"]) {
      const r = await add({ rescueVia: "template", rescueAt: ago(95) });
      await purgeAbandonedSignups(t.db, NOW);
      const back = new Date(NOW.getTime() + DAY);
      expect((await say(r.e164, { replyId }, back)).outbound).toEqual([es.signupStopped()]);
      expect((await get(r.id))?.contactOffAt).toEqual(back);
    }
  });

  it("16: vuelve, se queda otros 91 días y la limpieza la vacía otra vez con la marca", async () => {
    const r = await add({ contactOffAt: ago(200), updatedAt: ago(200) });
    await purgeAbandonedSignups(t.db, ago(100));
    await say(r.e164, { text: "hola" }, ago(95));
    expect(await purgeAbandonedSignups(t.db, NOW)).toEqual({ deleted: 0, kept: 1 });
    expect(await get(r.id)).toMatchObject({ contactOffAt: ago(200), purgedAt: NOW });
  });

  it("17: 60 filas vaciadas en la última hora no bloquean a un número nuevo", async () => {
    await t.db.insert(schema.signup).values(
      Array.from({ length: 60 }, (_, i) => ({
        e164: `58426800${String(i).padStart(4, "0")}`,
        step: "name",
        data: {},
        contactOffAt: ago(100),
        createdAt: NOW,
        updatedAt: NOW,
        purgedAt: NOW,
      })),
    );
    expect(await canStartSignup(t.db, "584269999999", NOW)).toBe(true);
  });

  it("18: erase_tenant borra la fila vaciada de su número", async () => {
    const e164 = "584267770001";
    await t.db.insert(schema.signup).values({
      e164,
      step: "name",
      data: {},
      contactOffAt: ago(100),
      purgedAt: NOW,
    });
    const tenantId = await seedTenant(t.db, {
      name: "X",
      businessType: "retail",
      ownerPhone: e164,
    });
    await withTenant(t.db, tenantId, (tx) => eraseTenant(tx, tenantId));
    expect(await t.db.select().from(schema.signup).where(eq(schema.signup.e164, e164))).toEqual([]);
  });
});
