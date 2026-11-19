import { and, eq, schema, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { routePrefs } from "../src/inbox/prefs";
import { saveHabitSettings } from "../src/ledger/habits";
import {
  planReaskBatch,
  REASK_KEY,
  REASK_PAYLOADS,
  REASK_SCHEDULE_KEY,
  runReaskBatch,
  runScheduledReaskBatch,
  scheduleReaskBatch,
} from "../src/onboarding/reask-batch";
import { BATCH_KEY, BatchRefused } from "../src/onboarding/signup-batch";
import { SCHEDULE_KEY, scheduleSignupBatch } from "../src/onboarding/signup-batch-schedule";
import { saveSignupRescueSettings } from "../src/onboarding/signup-rescue";
import { MetaClient } from "../src/whatsapp/client";

/** E3-t (agencia 19/11 §7, A-0053): la pregunta por plantilla a los dueños callados, una vez. */
const H = 3_600_000;
const DAY = 24 * H;
/** Martes 10/11/2026, 10:05 de Caracas. */
const START = new Date("2026-11-10T14:05:00Z");
const TEMPLATE = { name: "rocco_pregunta_recordatorio", language: "es", wabaId: "WABA" };

function fakeMeta(opts: { unreadable?: boolean } = {}) {
  const sent: { to: string; template: { components: { parameters: { payload: string }[] }[] } }[] =
    [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!init?.method || init.method === "GET") {
      if (opts.unreadable)
        return new Response(JSON.stringify({ error: { message: "x", code: 10 } }), { status: 403 });
      if (u.includes("message_templates"))
        return new Response(
          JSON.stringify({
            data: [
              {
                name: TEMPLATE.name,
                status: "APPROVED",
                category: "MARKETING",
                quality_score: { score: "GREEN" },
              },
            ],
          }),
          { status: 200 },
        );
      return new Response(JSON.stringify({ quality_rating: "GREEN" }), { status: 200 });
    }
    const body = JSON.parse(String(init.body)) as (typeof sent)[number];
    sent.push({ to: body.to, template: body.template });
    return new Response(
      JSON.stringify({ messages: [{ id: `wamid.Q${sent.length}`, message_status: "accepted" }] }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { sent, client: new MetaClient({ accessToken: "T", phoneNumberId: "P", fetchImpl }) };
}

describe("E3-t: lote único de la pregunta por plantilla", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let clock = START;
  const tenants: Record<string, { tenantId: string; phoneId: string; e164: string }> = {};
  const names = [
    "eligible",
    "eligible2",
    "internal",
    "test",
    "blocked",
    "no_movement",
    "answered",
    "already_sent",
    "opted_out",
    "no_contact",
    "pending",
    "window_open",
    "founder",
  ];
  const movement = (tenantId: string, phoneId: string, when: Date) =>
    withTenant(t.db, tenantId, (tx) =>
      tx.insert(schema.movement).values({
        tenantId,
        type: "expense",
        amount: "1.00",
        currency: "USD",
        amountUsd: "1.00",
        amountVes: "200.00",
        rateValue: "200.00000000",
        rateSource: "manual",
        businessDate: "2026-11-01",
        paymentMethod: "unspecified",
        origin: "single",
        sourceChannel: "text",
        createdByPhoneId: phoneId,
        createdAt: when,
      }),
    );
  const inbound = (tenantId: string, phoneId: string, when: Date) =>
    withTenant(t.db, tenantId, (tx) =>
      tx.insert(schema.message).values({
        tenantId,
        phoneId,
        direction: "in",
        kind: "text",
        body: "x",
        createdAt: when,
      }),
    );
  const run = (meta: MetaClient, over: Partial<Parameters<typeof runReaskBatch>[2]> = {}) =>
    runReaskBatch(t.db, meta, {
      template: TEMPLATE,
      onlyPhoneIds: Object.values(tenants).map((x) => x.phoneId),
      parkNumbers: [tenants.test?.e164 ?? ""],
      now: () => clock,
      sleep: async (ms) => {
        clock = new Date(clock.getTime() + ms);
      },
      ...over,
    });

  beforeAll(async () => {
    t = await createTestDb();
    for (const [k, name] of names.entries()) {
      const e164 = `5841200000${String(k).padStart(2, "0")}`;
      const tenantId = await seedTenant(t.db, { name, businessType: "personal", ownerPhone: e164 });
      const [p] = await t.db
        .select()
        .from(schema.phoneNumber)
        .where(eq(schema.phoneNumber.tenantId, tenantId));
      tenants[name] = { tenantId, phoneId: p?.id ?? "", e164 };
    }
    // Un cajero en el negocio elegible: nunca recibe E3-t.
    const e = tenants.eligible as { tenantId: string };
    await withTenant(t.db, e.tenantId, (tx) =>
      tx.insert(schema.phoneNumber).values({
        tenantId: e.tenantId,
        e164: "584149876543",
        role: "employee",
        status: "active",
        verifiedAt: START,
      }),
    );
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    clock = START;
    for (const k of [REASK_KEY, REASK_SCHEDULE_KEY, BATCH_KEY, SCHEDULE_KEY])
      await t.db.delete(schema.appSetting).where(eq(schema.appSetting.key, k));
    await t.db.delete(schema.auditLog);
    await t.db.delete(schema.signup);
    await saveHabitSettings(t.db, { prefs: true, nudge: true, reengageAsk: true }, "test", START);
    // Las pruebas corren como dueño de las tablas (sin RLS): se borra todo una vez.
    await t.db.delete(schema.message);
    await t.db.delete(schema.movement);
    for (const [name, x] of Object.entries(tenants)) {
      await withTenant(t.db, x.tenantId, async (tx) => {
        await tx
          .update(schema.tenant)
          .set({
            crmTags:
              name === "internal" ? ["interna"] : name === "no_contact" ? ["no-contactar"] : [],
            status: name === "blocked" ? "suspended" : "trial",
            trialEndsAt: new Date(START.getTime() + 20 * DAY),
          })
          .where(eq(schema.tenant.id, x.tenantId));
        await tx
          .update(schema.phoneNumber)
          .set({
            reengageOptInAt: name === "answered" ? START : null,
            reengageDeclinedAt: null,
            nudgeOffAt: name === "opted_out" ? START : null,
            unsolicitedOffAt: null,
            prefPending: name === "pending" ? "all_off" : null,
          })
          .where(eq(schema.phoneNumber.tenantId, x.tenantId));
      });
      if (name !== "no_movement")
        await movement(x.tenantId, x.phoneId, new Date(START.getTime() - 10 * DAY));
      // Callados: escribieron hace días (el elegible 2, más reciente).
      await inbound(
        x.tenantId,
        x.phoneId,
        new Date(
          START.getTime() - (name === "eligible2" ? 3 : name === "window_open" ? 0.1 : 8) * DAY,
        ),
      );
      if (name === "already_sent")
        await withTenant(t.db, x.tenantId, (tx) =>
          tx.insert(schema.message).values({
            tenantId: x.tenantId,
            phoneId: x.phoneId,
            direction: "out",
            kind: "template",
            status: "failed",
            createdAt: new Date(START.getTime() - 20 * DAY),
            toolCalls: [{ name: "reengage_ask_t", args: {} }],
          }),
        );
    }
    await t.db.insert(schema.signup).values({
      e164: tenants.founder?.e164 ?? "",
      step: "done",
      data: {},
      founderContactedAt: new Date(START.getTime() - 2 * DAY),
    });
  });

  it("simulación: cada razón de exclusión y la actividad más reciente primero", async () => {
    const plan = await planReaskBatch(t.db, {
      now: START,
      parkNumbers: [tenants.test?.e164 ?? ""],
    });
    expect(plan.excluded).toEqual({
      employee: 1,
      internal: 1,
      test: 1,
      blocked: 1,
      no_movement: 1,
      answered: 1,
      already_sent: 1,
      opted_out: 1,
      no_contact: 1,
      pending: 1,
      window_open: 1,
      founder: 1,
    });
    expect(plan.rows.map((r) => r.phoneId)).toEqual([
      tenants.eligible2?.phoneId,
      tenants.eligible?.phoneId,
    ]);
    expect(plan.costUsd).toBe(0.15);
  });

  it("corre una vez: los dos elegibles, con sus tres payloads y la marca; la segunda se niega", async () => {
    const meta = fakeMeta();
    const r = await run(meta.client);
    expect(r).toMatchObject({ sent: 2, stop: null, optOuts: 0 });
    expect(meta.sent.map((s) => s.to)).toEqual([tenants.eligible2?.e164, tenants.eligible?.e164]);
    expect(meta.sent[0]?.template.components.map((c) => c.parameters[0]?.payload)).toEqual(
      REASK_PAYLOADS,
    );
    expect(REASK_PAYLOADS).toEqual(["pref:reengage_yes", "pref:reengage_no", "pref:yes:all_off"]);
    const marks = await t.db
      .select()
      .from(schema.message)
      .where(
        and(
          eq(schema.message.phoneId, tenants.eligible?.phoneId ?? ""),
          eq(schema.message.direction, "out"),
        ),
      );
    expect(marks.map((m) => [m.status, m.toolCalls])).toEqual([
      ["ok", [{ name: "reengage_ask_t", args: { template: TEMPLATE.name } }]],
    ]);
    clock = START;
    await expect(run(fakeMeta().client)).rejects.toThrow("ya hubo una corrida de E3-t");
  });

  it("con la ventana abierta al momento de enviar, no sale (E3-r lo hace gratis)", async () => {
    await inbound(
      tenants.eligible?.tenantId ?? "",
      tenants.eligible?.phoneId ?? "",
      new Date(START.getTime() + 60_000),
    );
    const meta = fakeMeta();
    // Ya escribió: queda fuera desde la simulación.
    const r = await run(meta.client);
    expect(r.sent).toBe(1);
    expect(meta.sent.map((s) => s.to)).toEqual([tenants.eligible2?.e164]);
  });

  it("se niega sin la calidad leída, con E3 apagado o fuera de mar–jue 10:00–10:45", async () => {
    await expect(run(fakeMeta({ unreadable: true }).client)).rejects.toThrow(/S6/);
    await saveHabitSettings(t.db, { reengageAsk: false }, "test", START);
    await expect(run(fakeMeta().client)).rejects.toThrow(/S1/);
    await saveHabitSettings(t.db, { reengageAsk: true }, "test", START);
    clock = new Date("2026-11-09T14:05:00Z");
    await expect(run(fakeMeta().client)).rejects.toThrow(BatchRefused);
  });

  it("«Sí, recuérdame» desde E3-t = los mismos campos que E3, con text_id E3-t", async () => {
    const meta = fakeMeta();
    await run(meta.client);
    const x = tenants.eligible as { tenantId: string; phoneId: string };
    const now = new Date(START.getTime() + DAY);
    const r = await withTenant(t.db, x.tenantId, (tx) =>
      routePrefs(
        tx,
        {
          tenantId: x.tenantId,
          phoneId: x.phoneId,
          role: "owner",
          held: false,
          privacyContact: "p@x",
          now,
          replyTo: "wamid.Q2",
        },
        { replyId: "pref:reengage_yes" },
      ),
    );
    expect(r?.outbound[0]?.body).toBe(
      "Dale, mañana te recuerdo si no has anotado nada. Para apagarlo: *no me recuerdes*.",
    );
    const [p] = await withTenant(t.db, x.tenantId, (tx) =>
      tx.select().from(schema.phoneNumber).where(eq(schema.phoneNumber.id, x.phoneId)),
    );
    expect(p?.nudgeOptInAt?.getTime()).toBe(now.getTime());
    expect(p?.reengageOptInAt?.getTime()).toBe(now.getTime());
    expect(p?.nudgeOffAt).toBeNull();
    // Su único día con registros (hace 10 días, 10:05): esa hora.
    expect(p?.reengageMinute).toBe(10 * 60 + 5);
    const audits = await t.db
      .select({ action: schema.auditLog.action, after: schema.auditLog.after })
      .from(schema.auditLog);
    expect(audits).toEqual([
      { action: "nudge_opt_in", after: { source: "button", text_id: "E3-t", text_version: "v1" } },
      {
        action: "reengage_opt_in",
        after: { source: "button", text_id: "E3-t", text_version: "v1" },
      },
    ]);
  });

  it("programado: nunca el mismo día que el lote del registro (en los dos sentidos)", async () => {
    const evening = new Date("2026-11-09T23:00:00Z"); // lunes 19:00 de Caracas
    await saveSignupRescueSettings(t.db, { template: false }, "test", evening);
    await t.db.insert(schema.signup).values({
      e164: "584269990000",
      step: "name",
      data: {},
      updatedAt: new Date(evening.getTime() - 2 * DAY),
    });
    await scheduleSignupBatch(t.db, { actor: "test", now: evening });
    await expect(scheduleReaskBatch(t.db, { actor: "test", now: evening })).rejects.toThrow(
      "ese día ya hay otro lote de plantillas",
    );
    await t.db.delete(schema.appSetting).where(eq(schema.appSetting.key, SCHEDULE_KEY));
    const s = await scheduleReaskBatch(t.db, { actor: "test", now: evening });
    expect(s.status).toBe("scheduled");
    // Desde /admin no hay lista de números de prueba (como el lote del registro): esos se marcan
    // «interna». Aquí sale también el de prueba.
    expect(s.confirm).toBe(3);
    await expect(scheduleSignupBatch(t.db, { actor: "test", now: evening })).rejects.toThrow(
      "ese día ya hay otro lote de plantillas",
    );
    // A la hora: corre con esa lista y queda «done»; otra vuelta no hace nada.
    clock = START;
    const meta = fakeMeta();
    const r = await runScheduledReaskBatch(t.db, meta.client, {
      template: TEMPLATE,
      now: () => clock,
      sleep: async (ms) => {
        clock = new Date(clock.getTime() + ms);
      },
    });
    expect(r).toMatchObject({ ran: true, refused: null });
    expect(meta.sent).toHaveLength(3);
    expect(
      await runScheduledReaskBatch(t.db, meta.client, {
        template: TEMPLATE,
        now: () => clock,
        sleep: async () => {},
      }),
    ).toEqual({ ran: false, why: "none" });
  });
});
