import { eq, schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LlmClient, LlmResponse } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import { addDays, businessDateOf } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";
import { ingestWebhook } from "../src/inbox/ingest";
import { type ProcessDeps, processInbound } from "../src/inbox/process";
import { saveHabitSettings } from "../src/ledger/habits";
import { es } from "../src/render/index";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/**
 * Retención E3 (agencia 19/11 §3, A-0051): la pregunta en la tarjeta guardada, los botones «Sí,
 * recuérdame» y «No, gracias», los toques de la plantilla E1 y los textos que cambian por E1.
 */
const OWNER = "584121234567";
const CASHIER = "584149876543";
const DAY = 86_400_000;
const E3 = es.REENGAGE_ASK_LINES.E3;
const E3N = es.REENGAGE_ASK_LINES["E3-n"];
const E3R = es.REENGAGE_ASK_LINES["E3-r"];

const llmFor = (script: Record<string, LlmResponse["toolCalls"]>): LlmClient => ({
  model: "fake",
  async complete(req) {
    const last = req.turns[req.turns.length - 1];
    const text = last && "text" in last ? (last.text ?? "") : "";
    const key = Object.keys(script).find((k) => text.includes(k));
    return {
      toolCalls: key
        ? (script[key] ?? [])
        : [{ id: "q", name: "ask_clarification", input: { question: "¿Qué?", options: [] } }],
      text: null,
      stopReason: "tool_use" as const,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: "fake",
    };
  },
  costUsd: () => new Decimal(0),
});

const expense = (amount: string, description: string) => [
  {
    id: "e",
    name: "draft_expense",
    input: {
      amount,
      currency: "USD",
      description,
      category_name: "",
      when: "",
      rate: "",
      corrects_draft: false,
    },
  },
];
const exchange = [
  {
    id: "x1",
    name: "exchange_usdt",
    input: { action: "record", usd_amount: "100", ves_amount: "", rate: "205", when: "" },
  },
];

/** Hoy (o `dayOffset` días) a las hh:mm de Caracas. */
const at = (hh: number, mm: number, dayOffset = 0) => {
  const d = addDays(businessDateOf(new Date()), dayOffset);
  return new Date(`${d}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00-04:00`);
};

async function harness() {
  const t = await createTestDb();
  const tenantId = await seedTenant(t.db, {
    name: "Ana",
    businessType: "personal",
    ownerPhone: OWNER,
  });
  for (let i = 0; i < 10; i++)
    await t.db
      .insert(schema.bcvRate)
      .values({
        effectiveDate: addDays(businessDateOf(new Date()), -i),
        rate: "200.00000000",
        source: "test",
      })
      .onConflictDoNothing();
  await withTenant(t.db, tenantId, (tx) =>
    tx.insert(schema.phoneNumber).values({
      tenantId,
      e164: CASHIER,
      role: "employee",
      status: "active",
      verifiedAt: new Date(),
    }),
  );
  const llm = llmFor({
    "gasté 5$ en café": expense("5", "café"),
    "gasté 6$ en pan": expense("6", "pan"),
    "cambié 100 usdt a 205": exchange,
  });
  const sent: { to: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (body.status !== "read") sent.push({ to: String(body.to ?? ""), body });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT.${Math.random()}` }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const client = new MetaClient({ accessToken: "T", phoneNumberId: fx.PHONE_NUMBER_ID, fetchImpl });
  const deps = (): ProcessDeps => ({
    db: t.db,
    metaFor: () => client,
    agent: createAgent({ llm, now: () => new Date() }),
    now: () => new Date(),
    config: {
      assistantName: "Rocco",
      dashboardUrl: "https://caja.test",
      supportHint: null,
      privacyContact: "privacidad@caja.test",
      unknownReplyMax: 50,
      unknownReplyWindowMs: 3_600_000,
      maxEventAgeMs: 12 * 3_600_000,
      maxTextLength: 500,
      captionWaitMs: 0,
      knownMax: 10_000,
    },
  });
  let seq = 0;
  const jobs: ProcessMessageJob[] = [];
  async function deliver(p: unknown) {
    jobs.length = 0;
    await ingestWebhook(
      { db: t.db, now: () => new Date(), enqueue: async (_tx, job) => void jobs.push(job) },
      p,
    );
    await processInbound(deps(), jobs[0] as ProcessMessageJob);
  }
  const lastText = () => {
    const last = sent.at(-1)?.body;
    return String(
      (last?.text as { body?: string } | undefined)?.body ??
        (last?.interactive as { body: { text: string } } | undefined)?.body.text ??
        "",
    );
  };
  async function send(text: string, phone = OWNER) {
    const p = structuredClone(fx.textMessage(`wamid.H${++seq}`, text)) as unknown as {
      entry: {
        changes: { value: { messages: { from: string }[]; contacts: { wa_id: string }[] } }[];
      }[];
    };
    const v = p.entry[0]?.changes[0]?.value;
    if (v?.messages[0]) v.messages[0].from = phone;
    if (v?.contacts[0]) v.contacts[0].wa_id = phone;
    await deliver(p);
    return lastText();
  }
  /**
   * Toca un botón. `template`: el toque de una respuesta rápida de plantilla (tipo `button`) que
   * responde al mensaje `context` de Rocco.
   */
  async function tap(id: string, opts: { phone?: string; context?: string } = {}) {
    const p = structuredClone(fx.buttonReply) as unknown as {
      entry: {
        changes: {
          value: { messages: Record<string, unknown>[]; contacts: { wa_id: string }[] };
        }[];
      }[];
    };
    const v = p.entry[0]?.changes[0]?.value;
    const m = v?.messages[0];
    const phone = opts.phone ?? OWNER;
    if (m) {
      m.from = phone;
      m.id = `wamid.T${++seq}`;
      if (opts.context) {
        m.type = "button";
        delete m.interactive;
        m.button = { payload: id, text: "x" };
        m.context = { from: "15551234567", id: opts.context };
      } else {
        m.interactive = { type: "button_reply", button_reply: { id, title: "x" } };
        delete m.context;
      }
    }
    if (v?.contacts[0]) v.contacts[0].wa_id = phone;
    await deliver(p);
    return lastText();
  }
  const ids = () => {
    const i = sent.at(-1)?.body.interactive as
      | { action?: { buttons?: { reply: { id: string } }[] } }
      | undefined;
    return i?.action?.buttons?.map((b) => b.reply.id) ?? [];
  };
  return { t, tenantId, sent, send, tap, ids };
}

describe("E3: la pregunta en la tarjeta guardada", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  const phone = async () => {
    const [p] = await h.t.db
      .select()
      .from(schema.phoneNumber)
      .where(eq(schema.phoneNumber.e164, OWNER));
    if (!p) throw new Error("sin teléfono");
    return p;
  };
  const askMarks = async () =>
    (await h.t.db.select({ tc: schema.message.toolCalls }).from(schema.message))
      .flatMap((m) => (m.tc ?? []) as { name: string; args?: Record<string, unknown> }[])
      .filter((c) => c.name === "reengage_ask");
  const consents = () =>
    h.t.db
      .select({ action: schema.auditLog.action, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entity, "phone_number"));
  /** El primer movimiento del negocio pasa a `when` (la tarjeta de un gasto no tiene lugar). */
  const firstMovementAt = (when: Date) =>
    withTenant(h.t.db, h.tenantId, (tx) => tx.update(schema.movement).set({ createdAt: when }));

  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.t.close());
  beforeEach(async () => {
    await withTenant(h.t.db, h.tenantId, async (tx) => {
      await tx.delete(schema.pendingAction);
      await tx.delete(schema.movement);
      await tx.delete(schema.exchangeLot);
      await tx.delete(schema.noSpendDay);
      await tx.delete(schema.message);
      // Sin la pregunta de la tasa del primer cambio: la tarjeta del cambio queda con 1 botón.
      await tx
        .update(schema.tenant)
        .set({ crmTags: [], bsRateMode: "ask" })
        .where(eq(schema.tenant.id, h.tenantId));
    });
    await h.t.db.delete(schema.auditLog);
    await h.t.db.update(schema.phoneNumber).set({
      nudgeOptInAt: null,
      nudgeOffAt: null,
      unsolicitedOffAt: null,
      nudgePausedUntil: null,
      prefPending: null,
      prefPendingAt: null,
      reengageOptInAt: null,
      reengageDeclinedAt: null,
      reengageMinute: null,
    });
    await saveHabitSettings(
      h.t.db,
      {
        prefs: true,
        nudge: true,
        noSpend: true,
        streakLine: false,
        reengageAsk: true,
        reengageTemplate: false,
        nightRotation: false,
      },
      "test",
      new Date(),
    );
  });

  it("la tarjeta del primer gasto (2 botones) no tiene lugar: la pregunta va en la próxima que quepa (≤ 48 h), nunca aparte", async () => {
    const before = h.sent.length;
    const card = await h.send("gasté 5$ en café");
    // Un solo mensaje por turno y sin la pregunta: los dos botones no caben.
    expect(h.sent.length - before).toBe(1);
    expect(card).not.toContain(E3);
    expect(h.ids()).toHaveLength(2);
    expect(await askMarks()).toEqual([]);
    await firstMovementAt(at(10, 0, -1));
    const n = h.sent.length;
    const ex = await h.send("cambié 100 usdt a 205");
    expect(h.sent.length - n).toBe(1);
    expect(ex.endsWith(`\n\n${E3}`)).toBe(true);
    expect(h.ids().slice(-2)).toEqual(["pref:reengage_yes", "pref:reengage_no"]);
    expect(await askMarks()).toEqual([{ name: "reengage_ask", args: { v: "E3" } }]);
    // La siguiente ya no la lleva.
    await h.send("cambié 100 usdt a 205");
    expect(await askMarks()).toHaveLength(1);
  });

  it("primer movimiento de noche (20:26–07:59) → E3-n", async () => {
    await h.send("gasté 5$ en café");
    await firstMovementAt(at(22, 10, -1));
    expect((await h.send("cambié 100 usdt a 205")).endsWith(`\n\n${E3N}`)).toBe(true);
    expect(await askMarks()).toEqual([{ name: "reengage_ask", args: { v: "E3-n" } }]);
  });

  it("quien ya anotaba (primer movimiento de hace más de 48 h) → E3-r, una sola vez", async () => {
    await h.send("gasté 5$ en café");
    await firstMovementAt(at(10, 0, -5));
    expect((await h.send("cambié 100 usdt a 205")).endsWith(`\n\n${E3R}`)).toBe(true);
    await h.send("cambié 100 usdt a 205");
    await h.send("cambié 100 usdt a 205");
    expect(await askMarks()).toEqual([{ name: "reengage_ask", args: { v: "E3-r" } }]);
  });

  it("E3 sin respuesta: E3-r no se encima mientras siga dentro de 48 h", async () => {
    await h.send("gasté 5$ en café");
    await firstMovementAt(at(10, 0, -1));
    await h.send("cambié 100 usdt a 205");
    await h.send("cambié 100 usdt a 205");
    expect((await askMarks()).map((m) => m.args?.v)).toEqual(["E3"]);
  });

  it("«Sí, recuérdame» → E3-sí; el aviso encendido, el consentimiento E1 y la hora del primer movimiento; auditoría con texto y versión", async () => {
    await h.send("gasté 5$ en café");
    await firstMovementAt(at(10, 7, -1));
    await h.t.db.update(schema.phoneNumber).set({
      nudgeOffAt: null,
      nudgePausedUntil: new Date(Date.now() + 5 * DAY),
    });
    await h.send("cambié 100 usdt a 205");
    expect(await h.tap("pref:reengage_yes")).toBe(
      "Dale, mañana te recuerdo si no has anotado nada. Para apagarlo: *no me recuerdes*.",
    );
    const p = await phone();
    expect(p.nudgeOptInAt).not.toBeNull();
    expect(p.nudgePausedUntil).toBeNull();
    expect(p.reengageOptInAt).not.toBeNull();
    expect(p.reengageDeclinedAt).toBeNull();
    // 10:07 → 10:05 (5 min hacia abajo).
    expect(p.reengageMinute).toBe(10 * 60 + 5);
    expect(await consents()).toEqual([
      { action: "nudge_opt_in", after: { source: "button", text_id: "E3", text_version: "v1" } },
      {
        action: "reengage_opt_in",
        after: { source: "button", text_id: "E3", text_version: "v1" },
      },
    ]);
    // Otro toque: la misma respuesta, sin otra auditoría.
    await h.tap("pref:reengage_yes");
    expect(await consents()).toHaveLength(2);
  });

  it("«Sí» a E3-n → 19:00", async () => {
    await h.send("gasté 5$ en café");
    await firstMovementAt(at(22, 10, -1));
    await h.send("cambié 100 usdt a 205");
    await h.tap("pref:reengage_yes");
    expect((await phone()).reengageMinute).toBe(19 * 60);
  });

  it("«No, gracias» → E3-no, guarda el no y no se vuelve a preguntar", async () => {
    await h.send("gasté 5$ en café");
    await firstMovementAt(at(10, 0, -1));
    await h.send("cambié 100 usdt a 205");
    expect(await h.tap("pref:reengage_no")).toBe(
      "Dale, sin recordatorios. Aquí sigo cuando quieras anotar algo.",
    );
    const p = await phone();
    expect(p.reengageDeclinedAt).not.toBeNull();
    expect([p.reengageOptInAt, p.nudgeOptInAt]).toEqual([null, null]);
    await firstMovementAt(at(10, 0, -9));
    await h.send("cambié 100 usdt a 205");
    await h.send("cambié 100 usdt a 205");
    expect(await askMarks()).toHaveLength(1);
  });

  it("con «no me escribas» o «no-contactar», ningún botón enciende nada (como el H8)", async () => {
    await h.send("gasté 5$ en café");
    await firstMovementAt(at(10, 0, -1));
    await h.send("cambié 100 usdt a 205");
    await h.t.db.update(schema.phoneNumber).set({ unsolicitedOffAt: new Date() });
    expect(await h.tap("pref:reengage_yes")).toBe(es.prefAlreadyOff("all_off").body);
    expect(await h.tap("pref:reengage_no")).toBe(es.prefAlreadyOff("all_off").body);
    await h.t.db.update(schema.phoneNumber).set({ unsolicitedOffAt: null });
    await withTenant(h.t.db, h.tenantId, (tx) =>
      tx
        .update(schema.tenant)
        .set({ crmTags: ["no-contactar"] })
        .where(eq(schema.tenant.id, h.tenantId)),
    );
    expect(await h.tap("pref:reengage_yes")).toBe(es.prefTagged("privacidad@caja.test").body);
    const p = await phone();
    expect([p.reengageOptInAt, p.reengageDeclinedAt, p.nudgeOptInAt]).toEqual([null, null, null]);
    expect(await consents()).toEqual([]);
  });

  it("sin «Recordatorio a su hora» encendido, no hay pregunta ni el toque enciende nada", async () => {
    await saveHabitSettings(h.t.db, { reengageAsk: false }, "test", new Date());
    await h.send("gasté 5$ en café");
    await firstMovementAt(at(10, 0, -1));
    expect(await h.send("cambié 100 usdt a 205")).not.toContain(E3);
    await h.tap("pref:reengage_yes");
    expect((await phone()).reengageOptInAt).toBeNull();
  });

  it("el cajero no ve la pregunta y su toque no enciende nada", async () => {
    await h.send("gasté 5$ en café");
    await firstMovementAt(at(10, 0, -1));
    expect(await h.send("cambié 100 usdt a 205", CASHIER)).not.toContain(E3);
    expect(await h.tap("pref:reengage_yes", { phone: CASHIER })).toBe(es.prefEmployee(false).body);
  });

  describe("los botones de la plantilla E1", () => {
    const TEMPLATE_WA = "wamid.E1TEMPLATE";
    const template = async () => {
      const p = await phone();
      await withTenant(h.t.db, h.tenantId, (tx) =>
        tx.insert(schema.message).values({
          tenantId: h.tenantId,
          phoneId: p.id,
          direction: "out",
          kind: "template",
          status: "ok",
          waMessageId: TEMPLATE_WA,
          createdAt: new Date(Date.now() - 3_600_000),
          toolCalls: [{ name: "reengage_t", args: { template: "rocco_recordatorio_anotar" } }],
        }),
      );
    };
    beforeEach(async () => {
      await saveHabitSettings(
        h.t.db,
        { reengageTemplate: true, noSpend: false },
        "test",
        new Date(),
      );
      await h.t.db.update(schema.phoneNumber).set({
        nudgeOptInAt: new Date(Date.now() - 9 * DAY),
        reengageOptInAt: new Date(Date.now() - 9 * DAY),
      });
      await template();
    });

    it("«Anotar gasto» → el ejemplo de siempre", async () => {
      expect(await h.tap("menu:expense", { context: TEMPLATE_WA })).toBe(es.promptExpense().body);
    });

    it("«Hoy no gasté» vale con `reengageTemplate` (sin `noSpend`); el de otro día → H52e", async () => {
      const today = businessDateOf(new Date());
      expect(await h.tap(`habit:nospend:${today}`, { context: TEMPLATE_WA })).toBe(
        "¡Arranca tu racha! 🔥 1 día. Hoy quedó anotado sin gastos.",
      );
      expect(await h.tap(`habit:nospend:${addDays(today, -1)}`, { context: TEMPLATE_WA })).toBe(
        "Ese botón era del aviso de otro día, así que no anoté nada.",
      );
    });

    it("«No me escribas» → apaga sin tarjeta (H12), audita E1-A y apaga E1", async () => {
      expect(await h.tap("pref:yes:all_off", { context: TEMPLATE_WA })).toBe(
        es.prefAllOffDone().body,
      );
      const p = await phone();
      expect(p.unsolicitedOffAt).not.toBeNull();
      expect(p.reengageOptInAt).toBeNull();
      expect(await consents()).toEqual([
        { action: "all_off", after: { source: "button", text_id: "E1-A", text_version: "v1" } },
        {
          action: "reengage_off",
          after: { source: "button", text_id: "E1-A", text_version: "v1" },
        },
      ]);
    });

    it("«no me recuerdes» confirmado también apaga E1; «actívame los avisos» no lo vuelve a encender", async () => {
      await h.send("no me recuerdes");
      await h.tap("pref:yes:nudges_off");
      expect((await phone()).reengageOptInAt).toBeNull();
      await h.send("actívame los avisos");
      const p = await phone();
      expect(p.nudgeOffAt).toBeNull();
      expect(p.reengageOptInAt).toBeNull();
    });
  });

  describe("textos que cambian por E1 (§3.3), con `reengageAsk`", () => {
    const BULLET = "• El recordatorio para anotar, aunque no me hayas escrito";

    it("H45 y H46 con la viñeta nueva después de «El mensaje de la noche»; H11 y H50 A nuevos; versión v1.5", async () => {
      await h.t.db.update(schema.phoneNumber).set({ nudgeOptInAt: new Date() });
      expect(await h.send("no me recuerdes")).toBe(
        [
          "¿Apago estos avisos?",
          "• El mensaje de la noche",
          BULLET,
          "• Los avisos adelantados de tus recordatorios",
          "Hasta que me contestes, no te los mando. Los recordatorios que pidas te siguen llegando a su hora o cuando me escribas.",
        ].join("\n"),
      );
      await h.tap("pref:keep:nudges_off");
      expect(await h.send("no me escribas")).toBe(
        [
          "¿Apago los mensajes que te mando por mi cuenta?",
          "• El mensaje de la noche",
          BULLET,
          "• Los avisos de tus recordatorios",
          "• Los mensajes sobre tu prueba",
          "Hasta que me contestes, no te los mando. Los avisos de un pago tuyo o del borrado de tus datos llegan igual.",
        ].join("\n"),
      );
      await h.tap("pref:keep:all_off");
      expect(await h.send("mis avisos")).toBe(
        "Tus avisos están encendidos: el mensaje de la noche y los avisos adelantados de tus recordatorios. Para apagar también los demás mensajes que te mando por mi cuenta: *no me escribas*. Y si aceptaste el recordatorio para anotar, te lo mando a tu hora aunque no me hayas escrito.",
      );
      await h.send("no me recuerdes");
      expect(await h.tap("pref:yes:nudges_off")).toBe(
        "Listo, ya no te escribo en la noche, ni te recuerdo anotar, ni te adelanto recordatorios. Los que me pidas te llegan a su hora o cuando me escribas. Para volver: *actívame los avisos*.",
      );
      expect(await consents()).toEqual([
        { action: "nudge_off", after: { source: "button", text_id: "H45", text_version: "v1.5" } },
      ]);
    });

    it("con `reengageAsk` apagado, los textos y la versión de antes (v1.4)", async () => {
      await saveHabitSettings(h.t.db, { reengageAsk: false }, "test", new Date());
      await h.t.db.update(schema.phoneNumber).set({ nudgeOptInAt: new Date() });
      expect(await h.send("no me recuerdes")).toBe(es.prefNudgesOffCard(false).body);
      expect(await h.send("no me recuerdes")).not.toContain(BULLET);
      expect(await h.tap("pref:yes:nudges_off")).toBe(es.prefNudgesOffDone(false).body);
      expect(await consents()).toEqual([
        { action: "nudge_off", after: { source: "button", text_id: "H45", text_version: "v1.4" } },
      ]);
    });
  });
});
