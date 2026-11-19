import { eq, schema, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, businessDateOf } from "../src/domain/dates";
import { takeUnsolicitedSlot } from "../src/inbox/gate";
import { ingestWebhook } from "../src/inbox/ingest";
import { pickNightVariant, runHabitNudges } from "../src/inbox/nudge";
import { reengagePayloads, reengageSlot, runReengage } from "../src/inbox/reengage";
import { reengageStats } from "../src/inbox/reengage-stats";
import { usualMinuteOf } from "../src/inbox/usual-hour";
import { saveHabitSettings } from "../src/ledger/habits";
import { es } from "../src/render/index";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/** Retención E1 y E2 (agencia 19/11, A-0051): la puerta, la hora habitual y la cola `reengage`. */
const OWNER = "584121234567";
const OWNER_B = "584121234568";
const CASHIER = "584149876543";
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Hoy (o `dayOffset` días) a las hh:mm de Caracas. */
const at = (hh: number, mm: number, dayOffset = 0) => {
  const d = addDays(businessDateOf(new Date()), dayOffset);
  return new Date(`${d}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00-04:00`);
};
const TODAY = () => businessDateOf(at(12, 0));

describe("hora habitual (paso 2)", () => {
  it("mediana del primer movimiento de cada día, 5 min hacia abajo", () => {
    expect(usualMinuteOf([9 * 60 + 12, 10 * 60 + 44, 18 * 60])).toBe(10 * 60 + 40);
    // Par: el promedio de los dos del medio (10:00 y 11:00 → 10:30).
    expect(usualMinuteOf([9 * 60, 10 * 60, 11 * 60, 19 * 60])).toBe(10 * 60 + 30);
  });
  it("con un solo día, ese día", () => {
    expect(usualMinuteOf([13 * 60 + 9])).toBe(13 * 60 + 5);
  });
  it("acotada a 08:00–20:25", () => {
    expect(usualMinuteOf([6 * 60])).toBe(8 * 60);
    expect(usualMinuteOf([23 * 60])).toBe(20 * 60 + 25);
  });
  it("sin datos, 19:00", () => {
    expect(usualMinuteOf([])).toBe(19 * 60);
  });
});

describe("¿le toca ahora? (paso 3)", () => {
  const usual = 15 * 60;
  it("ventana abierta: el texto de su hora a una hora después; una vuelta tardía (>60 min), nada", () => {
    const wrote = at(9, 0);
    expect(reengageSlot({ now: at(14, 55), usual, lastInboundAt: wrote })).toBeNull();
    expect(reengageSlot({ now: at(15, 0), usual, lastInboundAt: wrote })).toBe("text");
    expect(reengageSlot({ now: at(16, 0), usual, lastInboundAt: wrote })).toBe("text");
    expect(reengageSlot({ now: at(16, 5), usual, lastInboundAt: wrote })).toBeNull();
  });
  it("ventana cerrada: la plantilla, en la misma franja", () => {
    expect(reengageSlot({ now: at(15, 5), usual, lastInboundAt: null })).toBe("template");
    expect(reengageSlot({ now: at(16, 10), usual, lastInboundAt: null })).toBeNull();
  });
  it("si la ventana se cierra antes de su hora, sale en la última vuelta abierta, nunca más de 2 h antes", () => {
    // Escribió ayer a las 14:00: con el margen de 10 min, la ventana cierra hoy a las 13:50.
    const wrote = at(14, 0, -1);
    expect(reengageSlot({ now: at(13, 35), usual, lastInboundAt: wrote })).toBeNull();
    expect(reengageSlot({ now: at(13, 40), usual, lastInboundAt: wrote })).toBe("text");
    expect(reengageSlot({ now: at(13, 45), usual, lastInboundAt: wrote })).toBe("text");
    // A las 17:00 su hora: 13:40 es más de 2 h antes → nada; a su hora, la plantilla.
    expect(reengageSlot({ now: at(13, 40), usual: 17 * 60, lastInboundAt: wrote })).toBeNull();
    expect(reengageSlot({ now: at(17, 0), usual: 17 * 60, lastInboundAt: wrote })).toBe("template");
  });
});

describe("E2: arranques del mensaje de la noche", () => {
  it("persona y negocio; la cola de la racha intacta; sin variante, N1", () => {
    const n = (variant: es.NightVariant | undefined, personal: boolean, current = 12) =>
      es.habitNudge({
        current,
        best: 20,
        personal,
        noSpendDate: null,
        ...(variant ? { variant } : {}),
      }).body;
    expect(n(undefined, true)).toBe("¿Hubo algo hoy que anotar? Así sigue tu racha de 12 días 🔥");
    expect(n("N1", false)).toBe("¿Hubo ventas o gastos hoy? Así sigue tu racha de 12 días 🔥");
    expect(n("N3", true)).toBe(
      "¿Cómo te fue hoy? Si gastaste algo, dímelo y lo anoto. Así sigue tu racha de 12 días 🔥",
    );
    expect(n("N3", false, 6)).toBe(
      "¿Cómo estuvo el día? Si hubo ventas o gastos, dímelo y lo anoto. Así llegas a 7 días seguidos 🔥",
    );
    expect(n("N6", false, 1)).toBe(
      "Pana, ¿qué hubo hoy en el negocio? Cuéntame y lo dejo anotado.",
    );
    for (const v of es.NIGHT_VARIANTS) {
      expect(n(v, true).startsWith(es.NIGHT_OPENINGS[v].personal)).toBe(true);
      expect(n(v, false).startsWith(es.NIGHT_OPENINGS[v].business)).toBe(true);
    }
  });
});

describe("la cola `reengage` y la puerta `reengage_t`", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId = "";
  let tenantB = "";
  let tenantC = "";
  let phoneId = "";
  let phoneB = "";
  let cashierId = "";
  type Post = { to: string; body: Record<string, unknown> };
  const posts: Post[] = [];
  const quality = {
    status: "APPROVED" as string | null,
    category: "MARKETING" as string | null,
    score: "GREEN" as string | null,
    phone: "GREEN" as string | null,
    unreadable: false,
  };
  let script: (i: number) => { error?: number; held?: boolean } = () => ({});
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!init?.method || init.method === "GET") {
      if (quality.unreadable)
        return new Response(JSON.stringify({ error: { message: "sin permiso", code: 10 } }), {
          status: 403,
        });
      if (u.includes("message_templates"))
        return new Response(
          JSON.stringify({
            data: [
              {
                name: "rocco_recordatorio_anotar",
                status: quality.status,
                category: quality.category,
                quality_score: { score: quality.score },
              },
            ],
          }),
          { status: 200 },
        );
      return new Response(
        JSON.stringify({
          quality_rating: quality.phone,
          whatsapp_business_manager_messaging_limit: "TIER_1K",
        }),
        { status: 200 },
      );
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const r = script(i++);
    if (r.error)
      return new Response(JSON.stringify({ error: { message: "x", code: r.error } }), {
        status: 400,
      });
    posts.push({ to: String(body.to), body });
    return new Response(
      JSON.stringify({
        messages: [
          {
            id: `wamid.R${posts.length}.${Math.random()}`,
            message_status: r.held ? "held_for_quality_assessment" : "accepted",
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const meta = new MetaClient({ accessToken: "T", phoneNumberId: fx.PHONE_NUMBER_ID, fetchImpl });
  const TEMPLATE = { name: "rocco_recordatorio_anotar", language: "es", wabaId: "WABA" };
  let capWarnings = 0;
  let heldWarnings = 0;
  const run = (now: Date, over: Partial<Parameters<typeof runReengage>[2]> = {}) =>
    runReengage(t.db, meta, {
      now,
      template: TEMPLATE,
      capUsd: 10,
      rateUsd: 0.074,
      onCapReached: () => {
        capWarnings += 1;
      },
      onHeld: () => {
        heldWarnings += 1;
      },
      ...over,
    });

  const record = (tid: string, pid: string, when: Date) =>
    withTenant(t.db, tid, (tx) =>
      tx.insert(schema.movement).values({
        tenantId: tid,
        type: "expense",
        amount: "1.00",
        currency: "USD",
        amountUsd: "1.00",
        amountVes: "200.00",
        rateValue: "200.00000000",
        rateSource: "manual",
        businessDate: businessDateOf(when),
        paymentMethod: "unspecified",
        origin: "single",
        sourceChannel: "text",
        createdByPhoneId: pid,
        createdAt: when,
      }),
    );
  const wrote = (tid: string, pid: string, when: Date) =>
    withTenant(t.db, tid, (tx) =>
      tx.insert(schema.message).values({
        tenantId: tid,
        phoneId: pid,
        direction: "in",
        kind: "text",
        body: "x",
        createdAt: when,
      }),
    );
  const pastTemplate = (tid: string, pid: string, when: Date, status = "ok") =>
    withTenant(t.db, tid, (tx) =>
      tx.insert(schema.message).values({
        tenantId: tid,
        phoneId: pid,
        direction: "out",
        kind: "template",
        status,
        createdAt: when,
        toolCalls: [{ name: "reengage_t", args: { template: "rocco_recordatorio_anotar" } }],
      }),
    );
  const marks = (tid: string, name: string) =>
    withTenant(t.db, tid, async (tx) =>
      (await tx.select().from(schema.message)).filter((m) =>
        JSON.stringify(m.toolCalls ?? []).includes(`"${name}"`),
      ),
    );
  const bodyText = (p: Post | undefined) =>
    (p?.body.interactive as { body?: { text?: string } } | undefined)?.body?.text;
  const templatesSent = () => posts.filter((p) => p.body.type === "template");
  const textsSent = () => posts.filter((p) => p.body.type !== "template");
  const optIn = (pid: string, minute: number) =>
    t.db
      .update(schema.phoneNumber)
      .set({
        nudgeOptInAt: new Date(at(12, 0).getTime() - 20 * DAY),
        reengageOptInAt: new Date(at(12, 0).getTime() - 20 * DAY),
        reengageMinute: minute,
      })
      .where(eq(schema.phoneNumber.id, pid));
  /** La hora habitual ya se calculó hoy (las pruebas fijan `reengage_minute`). */
  const minuteDone = () =>
    t.db
      .insert(schema.appSetting)
      .values({ key: "reengage_state", value: { minuteDay: TODAY() } })
      .onConflictDoUpdate({
        target: schema.appSetting.key,
        set: { value: { minuteDay: TODAY() } },
      });

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, { name: "Ana", businessType: "personal", ownerPhone: OWNER });
    tenantB = await seedTenant(t.db, { name: "Bea", businessType: "food", ownerPhone: OWNER_B });
    tenantC = await seedTenant(t.db, {
      name: "Caro",
      businessType: "personal",
      ownerPhone: "584121234569",
    });
    const phones = await t.db.select().from(schema.phoneNumber);
    phoneId = phones.find((p) => p.e164 === OWNER)?.id ?? "";
    phoneB = phones.find((p) => p.e164 === OWNER_B)?.id ?? "";
    await withTenant(t.db, tenantId, async (tx) => {
      const [c] = await tx
        .insert(schema.phoneNumber)
        .values({
          tenantId,
          e164: CASHIER,
          role: "employee",
          status: "active",
          verifiedAt: new Date(),
        })
        .returning({ id: schema.phoneNumber.id });
      cashierId = c?.id ?? "";
    });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    posts.length = 0;
    i = 0;
    script = () => ({});
    capWarnings = 0;
    heldWarnings = 0;
    Object.assign(quality, {
      status: "APPROVED",
      category: "MARKETING",
      score: "GREEN",
      phone: "GREEN",
      unreadable: false,
    });
    for (const tid of [tenantId, tenantB, tenantC])
      await withTenant(t.db, tid, async (tx) => {
        await tx.delete(schema.movement);
        await tx.delete(schema.noSpendDay);
        await tx.delete(schema.message);
        await tx
          .update(schema.tenant)
          .set({
            crmTags: [],
            status: "trial",
            createdAt: new Date(at(12, 0).getTime() - DAY),
            trialEndsAt: new Date(at(12, 0).getTime() + 30 * DAY),
            surveySentAt: null,
            valueSentAt: null,
          })
          .where(eq(schema.tenant.id, tid));
      });
    await t.db.delete(schema.auditLog);
    await t.db.delete(schema.webhookEvent);
    await t.db.delete(schema.appSetting).where(eq(schema.appSetting.key, "reengage_state"));
    await t.db.delete(schema.appSetting).where(eq(schema.appSetting.key, "reengage_skips"));
    await t.db.update(schema.phoneNumber).set({
      nudgeOptInAt: null,
      nudgeOffAt: null,
      unsolicitedOffAt: null,
      nudgePausedUntil: null,
      prefPending: null,
      reengageOptInAt: null,
      reengageDeclinedAt: null,
      reengageMinute: null,
    });
    await saveHabitSettings(
      t.db,
      {
        prefs: true,
        nudge: true,
        noSpend: true,
        streakLine: true,
        dailyClose: false,
        reengageAsk: true,
        reengageTemplate: true,
        nightRotation: false,
      },
      "test",
      at(12, 0),
    );
    await minuteDone();
  });

  describe("la puerta `reengage_t` (paso 4)", () => {
    const now = at(10, 5);
    const gate = (pid = phoneId, tid = tenantId, over: { tenantBlocked?: boolean } = {}) =>
      withTenant(t.db, tid, (tx) =>
        takeUnsolicitedSlot(tx, {
          tenantId: tid,
          phoneId: pid,
          kind: "reengage_t",
          now,
          tenantBlocked: over.tenantBlocked ?? false,
        }),
      );
    beforeEach(() => optIn(phoneId, 600));

    it("deja pasar con la ventana cerrada (es una plantilla)", async () => {
      expect(await gate()).toEqual({ allow: true });
    });
    it("cada razón de negación", async () => {
      expect(await gate(phoneId, tenantId, { tenantBlocked: true })).toEqual({
        allow: false,
        reason: "tenant_blocked",
      });
      expect(await gate(cashierId)).toEqual({ allow: false, reason: "not_owner" });
      await withTenant(t.db, tenantId, (tx) =>
        tx
          .update(schema.tenant)
          .set({ crmTags: ["interna"] })
          .where(eq(schema.tenant.id, tenantId)),
      );
      expect(await gate()).toEqual({ allow: false, reason: "internal" });
      await withTenant(t.db, tenantId, (tx) =>
        tx
          .update(schema.tenant)
          .set({ crmTags: ["no-contactar"] })
          .where(eq(schema.tenant.id, tenantId)),
      );
      expect(await gate()).toEqual({ allow: false, reason: "opted_out" });
      await withTenant(t.db, tenantId, (tx) =>
        tx.update(schema.tenant).set({ crmTags: [] }).where(eq(schema.tenant.id, tenantId)),
      );
      const set = (v: Partial<typeof schema.phoneNumber.$inferInsert>) =>
        t.db.update(schema.phoneNumber).set(v).where(eq(schema.phoneNumber.id, phoneId));
      await set({ nudgeOffAt: now });
      expect(await gate()).toEqual({ allow: false, reason: "opted_out" });
      await set({ nudgeOffAt: null, unsolicitedOffAt: now });
      expect(await gate()).toEqual({ allow: false, reason: "opted_out" });
      await set({ unsolicitedOffAt: null, prefPending: "nudges_off" });
      expect(await gate()).toEqual({ allow: false, reason: "pending_opt_out" });
      await set({ prefPending: null, nudgePausedUntil: new Date(now.getTime() + DAY) });
      expect(await gate()).toEqual({ allow: false, reason: "paused" });
      await set({ nudgePausedUntil: null, reengageOptInAt: null });
      expect(await gate()).toEqual({ allow: false, reason: "not_opted_in" });
    });
    it("H8 solo (aviso de la noche aceptado, sin el «Sí» de E3) → not_opted_in", async () => {
      await t.db
        .update(schema.phoneNumber)
        .set({ reengageOptInAt: null, nudgeOptInAt: now })
        .where(eq(schema.phoneNumber.id, phoneId));
      expect(await gate()).toEqual({ allow: false, reason: "not_opted_in" });
    });
    it("failed_recent, slot ocupado, horario nocturno y aviso de la prueba", async () => {
      await pastTemplate(tenantId, phoneId, new Date(now.getTime() - 2 * DAY), "failed");
      expect(await gate()).toEqual({ allow: false, reason: "failed_recent" });
      await withTenant(t.db, tenantId, (tx) => tx.delete(schema.message));
      await withTenant(t.db, tenantId, (tx) =>
        tx.insert(schema.message).values({
          tenantId,
          phoneId,
          direction: "out",
          kind: "buttons",
          body: "x",
          createdAt: at(8, 30),
          toolCalls: [{ name: "habit_nudge", args: { n: 0 } }],
        }),
      );
      expect(await gate()).toEqual({ allow: false, reason: "slot_taken" });
      await withTenant(t.db, tenantId, (tx) => tx.delete(schema.message));
      expect(
        await withTenant(t.db, tenantId, (tx) =>
          takeUnsolicitedSlot(tx, {
            tenantId,
            phoneId,
            kind: "reengage_t",
            now: at(20, 31),
            tenantBlocked: false,
          }),
        ),
      ).toEqual({ allow: false, reason: "quiet_hours" });
      expect(
        await withTenant(t.db, tenantId, (tx) =>
          takeUnsolicitedSlot(tx, {
            tenantId,
            phoneId,
            kind: "reengage_t",
            now,
            tenantBlocked: false,
            lifecycleDueToday: true,
          }),
        ),
      ).toEqual({ allow: false, reason: "lifecycle_today" });
    });
  });

  it("interruptores apagados: no hace nada", async () => {
    await optIn(phoneId, 600);
    await saveHabitSettings(
      t.db,
      { reengageAsk: false, reengageTemplate: false },
      "test",
      at(12, 0),
    );
    expect(await run(at(10, 5))).toMatchObject({ off: true, text: 0, templates: 0 });
    expect(posts).toEqual([]);
  });

  it("ventana abierta → el mensaje de la noche como texto a su hora, con { v, at_usual }; nunca la plantilla el mismo día", async () => {
    await optIn(phoneId, 600);
    await wrote(tenantId, phoneId, at(7, 0));
    expect(await run(at(9, 55))).toMatchObject({ text: 0, templates: 0 });
    const r = await run(at(10, 5));
    expect(r).toMatchObject({ text: 1, templates: 0 });
    expect(textsSent()).toHaveLength(1);
    expect(bodyText(textsSent()[0])).toBe("¿Hubo algo hoy que anotar?");
    const [m] = await marks(tenantId, "habit_nudge");
    expect(m?.toolCalls).toEqual([
      { name: "habit_nudge", args: { n: 0, v: "N1", at_usual: true } },
    ]);
    expect(m?.status).toBe("ok");
    // La ventana se cierra después: la plantilla no sale el mismo día (la puerta ve la marca).
    await withTenant(t.db, tenantId, (tx) =>
      tx.delete(schema.message).where(eq(schema.message.direction, "in")),
    );
    expect((await run(at(10, 30))).skipped).toMatchObject({ slot_taken: 1 });
    expect(templatesSent()).toEqual([]);
  });

  it("con nightRotation, el texto a su hora también rota", async () => {
    await saveHabitSettings(t.db, { nightRotation: true }, "test", at(12, 0));
    await optIn(phoneId, 600);
    await wrote(tenantId, phoneId, at(7, 0));
    for (const [d, v] of [
      [-3, "N1"],
      [-2, "N2"],
    ] as const)
      await withTenant(t.db, tenantId, (tx) =>
        tx.insert(schema.message).values({
          tenantId,
          phoneId,
          direction: "out",
          kind: "buttons",
          body: "x",
          status: "ok",
          createdAt: at(10, 5, d),
          toolCalls: [{ name: "habit_nudge", args: { n: 0, v } }],
        }),
      );
    // Días cumplidos para que no entre la pausa.
    await record(tenantId, phoneId, at(12, 0, -3));
    await record(tenantId, phoneId, at(12, 0, -2));
    await run(at(10, 5));
    expect(bodyText(textsSent()[0])).toMatch(/^¿Cómo te fue hoy\?/);
  });

  it("ventana cerrada → la plantilla E1 con sus tres payloads (hoy); una por día", async () => {
    await optIn(phoneId, 600);
    const r = await run(at(10, 5));
    expect(r).toMatchObject({ text: 0, templates: 1 });
    const [p] = templatesSent();
    expect(p?.to).toBe(OWNER);
    const template = p?.body.template as {
      name: string;
      language: { code: string };
      components: { index: string; parameters: { payload: string }[] }[];
    };
    expect(template.name).toBe("rocco_recordatorio_anotar");
    expect(template.language.code).toBe("es");
    expect(template.components.map((c) => c.parameters[0]?.payload)).toEqual([
      "menu:expense",
      `habit:nospend:${TODAY()}`,
      "pref:yes:all_off",
    ]);
    expect(reengagePayloads(TODAY())).toEqual([
      "menu:expense",
      `habit:nospend:${TODAY()}`,
      "pref:yes:all_off",
    ]);
    const [m] = await marks(tenantId, "reengage_t");
    expect(m?.status).toBe("ok");
    expect(m?.waMessageId).toMatch(/^wamid\.R1/);
    expect((await run(at(10, 10))).skipped).toMatchObject({ slot_taken: 1 });
    expect(templatesSent()).toHaveLength(1);
  });

  it("nada cumplido hoy: con un registro de hoy, nada", async () => {
    await optIn(phoneId, 600);
    await record(tenantId, cashierId, at(9, 0));
    expect((await run(at(10, 5))).skipped).toMatchObject({ kept_today: 1 });
    expect(posts).toEqual([]);
  });

  it("vuelta tardía (más de 60 min después de su hora): nada", async () => {
    await optIn(phoneId, 600);
    expect((await run(at(11, 6))).skipped).toMatchObject({ not_due: 1 });
    expect(posts).toEqual([]);
  });

  it("corrida de 3: la 4.ª no sale; un mensaje suyo la reinicia", async () => {
    await optIn(phoneId, 600);
    for (const d of [-3, -2, -1]) await pastTemplate(tenantId, phoneId, at(10, 5, d));
    // El día de ayer quedó cumplido (lo anotó el cajero): no es la pausa, es la corrida.
    await record(tenantId, cashierId, at(15, 0, -1));
    expect((await run(at(10, 5))).skipped).toMatchObject({ run_done: 1 });
    expect(templatesSent()).toEqual([]);
    // Escribió ayer a las 10:10 (la ventana ya cerró): la corrida empieza de nuevo.
    await wrote(tenantId, phoneId, at(10, 10, -1));
    expect(await run(at(10, 15))).toMatchObject({ templates: 1 });
  });

  it("las plantillas ignoradas cuentan para la pausa de 14 días", async () => {
    await optIn(phoneId, 600);
    for (const d of [-3, -2, -1]) await pastTemplate(tenantId, phoneId, at(10, 5, d));
    expect(await run(at(10, 5))).toMatchObject({ paused: 1, templates: 0 });
    const [p] = await t.db
      .select()
      .from(schema.phoneNumber)
      .where(eq(schema.phoneNumber.id, phoneId));
    expect(p?.nudgePausedUntil?.getTime()).toBe(at(10, 5).getTime() + 14 * DAY);
  });

  it("tope: con el tope justo sale la última que cabe y la siguiente no; un aviso a Sentry por día", async () => {
    await optIn(phoneId, 600);
    await optIn(phoneB, 600);
    // Dos plantillas de otro negocio este mes.
    const cPhone = (await t.db.select().from(schema.phoneNumber)).find(
      (x) => x.tenantId === tenantC,
    );
    await pastTemplate(tenantC, cPhone?.id ?? "", new Date(at(10, 0).getTime() - HOUR));
    await pastTemplate(tenantC, cPhone?.id ?? "", new Date(at(10, 0).getTime() - 2 * HOUR));
    const r = await run(at(10, 5), { capUsd: 3 * 0.074 });
    expect(r.templates).toBe(1);
    expect(r.skipped).toMatchObject({ cap_reached: 1 });
    expect(capWarnings).toBe(1);
    await run(at(10, 10), { capUsd: 3 * 0.074 });
    expect(capWarnings).toBe(1);
    expect(templatesSent()).toHaveLength(1);
  });

  it("sin META_REENGAGE_MONTHLY_CAP_USD no sale ninguna plantilla", async () => {
    await optIn(phoneId, 600);
    expect((await run(at(10, 5), { capUsd: null })).skipped).toMatchObject({ no_cap: 1 });
    expect(posts).toEqual([]);
  });

  it("calidad: categoría UTILITY, número no GREEN, plantilla en amarillo o lectura sin datos → no sale", async () => {
    await optIn(phoneId, 600);
    quality.category = "UTILITY";
    expect((await run(at(10, 5))).skipped).toMatchObject({ quality: 1 });
    Object.assign(quality, { category: "MARKETING", phone: "YELLOW" });
    expect((await run(at(10, 5))).skipped).toMatchObject({ quality: 1 });
    Object.assign(quality, { phone: "GREEN", score: "YELLOW" });
    expect((await run(at(10, 5))).skipped).toMatchObject({ quality: 1 });
    Object.assign(quality, { score: "GREEN", unreadable: true });
    expect((await run(at(10, 5))).skipped).toMatchObject({ quality: 1 });
    Object.assign(quality, { unreadable: false });
    expect(
      (await run(at(10, 5), { template: { ...TEMPLATE, wabaId: null } })).skipped,
    ).toMatchObject({ quality: 1 });
    expect(posts).toEqual([]);
  });

  it("retenida por calidad: la cola para ese día y avisa", async () => {
    await optIn(phoneId, 600);
    await optIn(phoneB, 600);
    script = () => ({ held: true });
    const r = await run(at(10, 5));
    expect(r).toMatchObject({ held: 1, templates: 0 });
    expect(r.skipped).toMatchObject({ held_today: 1 });
    expect(heldWarnings).toBe(1);
    // La vuelta siguiente: ninguno de los dos (la retenida ya ocupa el día del primero).
    expect((await run(at(10, 10))).skipped).toMatchObject({ held_today: 2 });
    expect(templatesSent()).toHaveLength(1);
  });

  it("131049 (límite de marketing por usuario): se cuenta, no se reintenta y no bloquea 7 días", async () => {
    await optIn(phoneId, 600);
    script = () => ({ error: 131049 });
    const r = await run(at(10, 5));
    expect(r.failedByCode).toEqual({ "131049": 1 });
    const [m] = await marks(tenantId, "reengage_t");
    expect(m?.status).toBe("limited");
    expect(m?.toolCalls).toEqual([
      { name: "reengage_t", args: { template: "rocco_recordatorio_anotar", code: 131049 } },
    ]);
    script = () => ({});
    expect((await run(at(10, 10))).skipped).toMatchObject({ slot_taken: 1 });
    // Otro día no cuenta como fallo de la puerta.
    expect(
      await withTenant(t.db, tenantId, (tx) =>
        takeUnsolicitedSlot(tx, {
          tenantId,
          phoneId,
          kind: "reengage_t",
          now: at(10, 5, 1),
          tenantBlocked: false,
        }),
      ),
    ).toEqual({ allow: true });
  });

  it("la hora habitual se recalcula una vez al día, en la primera vuelta desde las 08:00", async () => {
    await optIn(phoneId, 600);
    await t.db.delete(schema.appSetting).where(eq(schema.appSetting.key, "reengage_state"));
    await record(tenantId, phoneId, at(9, 12, -3));
    await record(tenantId, phoneId, at(12, 0, -3));
    await record(tenantId, phoneId, at(10, 44, -2));
    await record(tenantId, phoneId, at(18, 0, -1));
    expect((await run(at(8, 0))).minutesUpdated).toBe(1);
    const minute = async () =>
      (await t.db.select().from(schema.phoneNumber).where(eq(schema.phoneNumber.id, phoneId)))[0]
        ?.reengageMinute;
    expect(await minute()).toBe(10 * 60 + 40);
    await t.db
      .update(schema.phoneNumber)
      .set({ reengageMinute: 900 })
      .where(eq(schema.phoneNumber.id, phoneId));
    expect((await run(at(8, 5))).minutesUpdated).toBe(0);
    expect(await minute()).toBe(900);
  });

  it("runHabitNudges: el aviso de las 8 pm no sale a quien dijo «Sí» a E3 (va a su hora); a los demás sí", async () => {
    await optIn(phoneId, 600);
    await t.db
      .update(schema.phoneNumber)
      .set({ nudgeOptInAt: new Date(at(12, 0).getTime() - 20 * DAY) })
      .where(eq(schema.phoneNumber.id, phoneB));
    for (const [tid, pid] of [
      [tenantId, phoneId],
      [tenantB, phoneB],
    ] as const) {
      await record(tid, pid, at(12, 0, -2));
      await record(tid, pid, at(12, 0, -1));
      await wrote(tid, pid, at(12, 0));
    }
    const r = await runHabitNudges(t.db, meta, { now: at(20, 5) });
    expect(r.sent).toBe(1);
    expect(r.skipped).toMatchObject({ at_usual: 1 });
    expect(posts.map((p) => p.to)).toEqual([OWNER_B]);
  });

  it("/admin: entregas (solo con E3 encendido), toques y «No me escribas» de la plantilla; solo conteos", async () => {
    await optIn(phoneId, 600);
    await run(at(10, 5));
    const [m] = await marks(tenantId, "reengage_t");
    const wa = m?.waMessageId ?? "";
    const delivered = (id: string) => {
      const p = structuredClone(fx.deliveredStatus) as unknown as {
        entry: { changes: { value: { statuses: { id: string }[] } }[] }[];
      };
      const s = p.entry[0]?.changes[0]?.value.statuses[0];
      if (s) s.id = id;
      return ingestWebhook({ db: t.db, enqueue: async () => {} }, p);
    };
    await delivered(wa);
    // La respuesta rápida de la plantilla: el evento guarda el contexto y el payload.
    const [ev] = await t.db
      .insert(schema.webhookEvent)
      .values({
        eventKey: "msg:wamid.TAP1",
        payload: { replyTo: wa, replyId: "pref:yes:all_off" },
        status: "done",
      })
      .returning({ id: schema.webhookEvent.id });
    await withTenant(t.db, tenantId, async (tx) => {
      await tx.insert(schema.message).values({
        tenantId,
        phoneId,
        direction: "in",
        kind: "interactive",
        body: "No me escribas",
        webhookEventId: ev?.id ?? null,
        createdAt: at(10, 20),
      });
      await tx.insert(schema.auditLog).values({
        tenantId,
        actorType: "phone",
        actorId: phoneId,
        action: "all_off",
        entity: "phone_number",
        entityId: phoneId,
        after: { source: "button", text_id: "E1-A", text_version: "v1" },
        channel: "whatsapp",
      });
    });
    const s = await withTenant(t.db, tenantId, (tx) =>
      reengageStats(tx, tenantId, new Date(at(10, 5).getTime() - 30 * DAY), at(11, 0)),
    );
    expect(s.e1).toMatchObject({
      sent: 1,
      delivered: 1,
      failed: 0,
      eligibleNow: 1,
      monthTemplates: 1,
      stopFromTemplate: 1,
      taps: { expense: 0, noSpend: 0, stop: 1 },
    });
    expect(JSON.stringify(s)).not.toContain(OWNER.slice(-7));
    // Con los interruptores apagados, la entrega no se guarda (como siempre: solo los fallidos).
    await saveHabitSettings(t.db, { reengageAsk: false }, "test", at(12, 0));
    await delivered("wamid.OTHER");
    expect((await t.db.select().from(schema.webhookEvent)).map((e) => e.eventKey).sort()).toEqual(
      ["msg:wamid.TAP1", `status:${wa}:delivered`].sort(),
    );
  });

  describe("E2: rotación del mensaje de la noche", () => {
    const past = (vs: (string | null)[]) =>
      withTenant(t.db, tenantId, async (tx) => {
        // `vs` del más reciente al más viejo; null = un aviso de antes de la rotación (N1).
        for (const [k, v] of vs.entries())
          await tx.insert(schema.message).values({
            tenantId,
            phoneId,
            direction: "out",
            kind: "buttons",
            body: "x",
            status: "ok",
            createdAt: at(20, 0, -(k + 1)),
            toolCalls: [{ name: "habit_nudge", args: { n: 2, ...(v ? { v } : {}) } }],
          });
      });
    const pick = () => withTenant(t.db, tenantId, (tx) => pickNightVariant(tx, phoneId));

    it("no repite ninguno de los últimos 5", async () => {
      await past(["N5", "N4", "N3", "N2", "N1"]);
      expect(await pick()).toBe("N6");
    });
    it("entre los que quedan, el que salió hace más tiempo; nunca mostrado gana; empate → id menor", async () => {
      expect(await pick()).toBe("N1");
      await past([null, null, null, null, null, "N4", "N5", "N6", "N2", "N3"]);
      expect(await pick()).toBe("N3");
    });
    it("empate entre nunca mostrados → el de id menor", async () => {
      await past(["N1", "N2", "N3"]);
      expect(await pick()).toBe("N4");
    });
    it("con nightRotation, runHabitNudges guarda `v` en la marca; apagado, N1 y sin `v`", async () => {
      await t.db
        .update(schema.phoneNumber)
        .set({ nudgeOptInAt: new Date(at(12, 0).getTime() - 20 * DAY) })
        .where(eq(schema.phoneNumber.id, phoneId));
      await record(tenantId, phoneId, at(12, 0, -2));
      await record(tenantId, phoneId, at(12, 0, -1));
      await wrote(tenantId, phoneId, at(12, 0));
      await runHabitNudges(t.db, meta, { now: at(20, 5) });
      const off = await marks(tenantId, "habit_nudge");
      expect(off[0]?.toolCalls).toEqual([{ name: "habit_nudge", args: { n: 2 } }]);
      expect(bodyText(posts[0])).toBe("¿Hubo algo hoy que anotar? Así sigue tu racha de 2 días 🔥");
      await withTenant(t.db, tenantId, (tx) =>
        tx.delete(schema.message).where(eq(schema.message.direction, "out")),
      );
      await past(["N1"]);
      await saveHabitSettings(t.db, { nightRotation: true }, "test", at(12, 0));
      await runHabitNudges(t.db, meta, { now: at(20, 5) });
      const on = (await marks(tenantId, "habit_nudge")).filter(
        (m) => m.createdAt.getTime() === at(20, 5).getTime(),
      );
      expect(on[0]?.toolCalls).toEqual([{ name: "habit_nudge", args: { n: 2, v: "N2" } }]);
      expect(bodyText(posts[1])).toBe(
        "Epa, ¿algo que anotar de hoy? Así sigue tu racha de 2 días 🔥",
      );
    });
  });
});
