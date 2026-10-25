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
import { habitStats, isNoSpendPhrase, saveHabitSettings, streakFor } from "../src/ledger/habits";
import { es } from "../src/render/index";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/**
 * Racha y "hoy no gasté nada" (PRD hábitos, fase 1). Reloj real: un día cuenta por la fecha de
 * Caracas en que se creó el registro, que la pone la base.
 */
const OWNER = "584121234567";
const CASHIER = "584149876543";
const DAY = 86_400_000;

describe("isNoSpendPhrase", () => {
  it("el mensaje entero, sin acentos ni mayúsculas", () => {
    for (const t of [
      "Hoy no gasté nada",
      "hoy no gaste",
      "No gasté nada hoy.",
      "hoy no hubo gastos",
      "hoy sin gastos",
      "sin gastos hoy",
      "hoy no hubo movimientos",
      "hoy no hubo nada que anotar",
      "hoy no hubo ventas ni gastos",
      "hoy no abrimos",
      "Hoy no abrí",
    ])
      expect(isNoSpendPhrase(t), t).toBe(true);
  });
  it("con algo más, o de otro día, no", () => {
    for (const t of [
      "hoy no gasté nada en comida",
      "hoy no gasté nada pero cobré 20$",
      "ayer no gasté nada",
      "no gasté nada en la farmacia, fueron 5$",
      "hoy no vendí nada",
    ])
      expect(isNoSpendPhrase(t), t).toBe(false);
  });
});

describe("textos de la racha (copy v1.2.3)", () => {
  const line = (current: number, bestBefore = 0, firstTime = false) =>
    es.streakLine({ current, bestBefore, firstTime });
  it("H1, H1a, H2, H3, H3b", () => {
    expect(line(1)).toBeNull();
    expect(line(2, 0, true)).toBe(
      "🔥 Llevas 2 días seguidos. Cada día que anotes algo, tu racha sigue.",
    );
    expect(line(12)).toBe("🔥 Llevas 12 días seguidos");
    expect(line(7)).toBe("🔥 ¡7 días seguidos! Una semana completa.");
    expect(line(30)).toBe("🔥 ¡30 días seguidos! Ya es un mes.");
    expect(line(12, 11)).toBe("🔥 Llevas 12 días seguidos. ¡Nuevo récord!");
    expect(line(13, 11)).toBe("🔥 Llevas 13 días seguidos");
    expect(line(4, 2)).toBe("🔥 Llevas 4 días seguidos");
    expect(line(100, 99)).toBe("🔥 ¡100 días seguidos! Eso sí es constancia. Y es tu récord.");
  });
  it("H52 (persona), H52b (negocio), H52c, H52d", () => {
    const body = (v: Parameters<typeof es.noSpendReply>[0]) => es.noSpendReply(v).body;
    const p = { kind: "marked" as const, personal: true, bestBefore: 0, previous: 0 };
    expect(body({ ...p, current: 12 })).toBe(
      "¡Tu racha sigue viva! 🔥 12 días seguidos. Hoy quedó anotado sin gastos.",
    );
    expect(body({ ...p, current: 1 })).toBe(
      "¡Arranca tu racha! 🔥 1 día. Hoy quedó anotado sin gastos.",
    );
    expect(body({ ...p, current: 1, bestBefore: 12, previous: 5 })).toBe(
      "¡Arrancamos una racha nueva! 🔥 Tu récord: 12 días. Hoy quedó anotado sin gastos.",
    );
    expect(body({ ...p, current: 7 })).toBe(
      "¡Tu racha sigue viva! 🔥 7 días seguidos. Una semana completa. Hoy quedó anotado sin gastos.",
    );
    expect(body({ ...p, current: 12, bestBefore: 11 })).toBe(
      "¡Tu racha sigue viva! 🔥 12 días seguidos. Es tu nuevo récord. Hoy quedó anotado sin gastos.",
    );
    expect(body({ ...p, current: 100, bestBefore: 99 })).toBe(
      "¡Tu racha sigue viva! 🔥 100 días seguidos. Eso sí es constancia. Y es tu récord. Hoy quedó anotado sin gastos.",
    );
    expect(body({ ...p, personal: false, current: 3 })).toBe(
      "Listo, anoté que hoy no hubo nada que registrar. Tu racha sigue: 3 días.",
    );
    expect(body({ ...p, personal: false, current: 1 })).toBe(
      "Listo, anoté que hoy no hubo nada que registrar. Tu racha empieza hoy.",
    );
    expect(body({ kind: "already_recorded" })).toBe(
      "Hoy ya hay movimientos anotados, así que el día ya cuenta para tu racha.",
    );
    expect(body({ kind: "already_marked", current: 4 })).toBe(
      "Ya lo tenía anotado. Tu racha sigue: 4 días.",
    );
    expect(body({ kind: "already_marked", current: 1 })).toBe(
      "Ya lo tenía anotado. Tu racha empieza hoy.",
    );
  });
});

function scriptedLlm(
  script: Record<string, LlmResponse["toolCalls"]>,
): LlmClient & { calls: number } {
  const llm = {
    calls: 0,
    model: "claude-sonnet-5-5",
    async complete(req: Parameters<LlmClient["complete"]>[0]) {
      llm.calls += 1;
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
        model: "claude-sonnet-5-5",
      };
    },
    costUsd: () => new Decimal(0),
  };
  return llm;
}

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

async function harness(businessType: string) {
  const t = await createTestDb();
  const tenantId = await seedTenant(t.db, { name: "Ana", businessType, ownerPhone: OWNER });
  const now = new Date();
  for (let i = 0; i < 10; i++)
    await t.db
      .insert(schema.bcvRate)
      .values({
        effectiveDate: addDays(businessDateOf(now), -i),
        rate: "200.00000000",
        source: "test",
      })
      .onConflictDoNothing();
  let ownerPhoneId = "";
  await withTenant(t.db, tenantId, async (tx) => {
    const [p] = await tx.select().from(schema.phoneNumber);
    ownerPhoneId = p?.id ?? "";
    await tx.insert(schema.phoneNumber).values({
      tenantId,
      e164: CASHIER,
      role: "employee",
      status: "active",
      verifiedAt: new Date(),
    });
  });
  const llm = scriptedLlm({
    "gasté 5$ en café": expense("5", "café"),
    "gasté 6$ en pan": expense("6", "pan"),
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
      unknownReplyMax: 50,
      unknownReplyWindowMs: 3_600_000,
      maxEventAgeMs: 12 * 3_600_000,
      maxTextLength: 500,
      captionWaitMs: 0,
    },
  });
  let seq = 0;
  const jobs: ProcessMessageJob[] = [];
  async function send(text: string, phone = OWNER) {
    const p = structuredClone(fx.textMessage(`wamid.H${++seq}`, text)) as unknown as {
      entry: {
        changes: { value: { messages: { from: string }[]; contacts: { wa_id: string }[] } }[];
      }[];
    };
    const v = p.entry[0]?.changes[0]?.value;
    if (v?.messages[0]) v.messages[0].from = phone;
    if (v?.contacts[0]) v.contacts[0].wa_id = phone;
    jobs.length = 0;
    await ingestWebhook(
      { db: t.db, now: () => new Date(), enqueue: async (_tx, job) => void jobs.push(job) },
      p,
    );
    await processInbound(deps(), jobs[0] as ProcessMessageJob);
    const last = sent.at(-1)?.body;
    return String(
      (last?.text as { body?: string } | undefined)?.body ??
        (last?.interactive as { body: { text: string } } | undefined)?.body.text ??
        "",
    );
  }
  /** Un gasto creado hace `daysAgo` días (la racha mira cuándo se creó). */
  const recordDaysAgo = (daysAgo: number, deletedAfterMs?: number) =>
    withTenant(t.db, tenantId, async (tx) => {
      const created = new Date(Date.now() - daysAgo * DAY);
      await tx.insert(schema.movement).values({
        tenantId,
        type: "expense",
        amount: "1.00",
        currency: "USD",
        amountUsd: "1.00",
        amountVes: "200.00",
        rateValue: "200.00000000",
        rateSource: "manual",
        businessDate: businessDateOf(created),
        paymentMethod: "unspecified",
        origin: "single",
        sourceChannel: "text",
        createdByPhoneId: ownerPhoneId,
        createdAt: created,
        ...(deletedAfterMs !== undefined
          ? { deletedAt: new Date(created.getTime() + deletedAfterMs) }
          : {}),
      });
    });
  const noSpendDaysAgo = (daysAgo: number) =>
    withTenant(t.db, tenantId, (tx) =>
      tx.insert(schema.noSpendDay).values({
        tenantId,
        phoneId: ownerPhoneId,
        day: businessDateOf(new Date(Date.now() - daysAgo * DAY)),
      }),
    );
  const reset = () =>
    withTenant(t.db, tenantId, async (tx) => {
      await tx.delete(schema.pendingAction);
      await tx.delete(schema.movement);
      await tx.delete(schema.noSpendDay);
      await tx.delete(schema.message);
    });
  const streak = () => withTenant(t.db, tenantId, (tx) => streakFor(tx, tenantId, new Date()));
  return { t, tenantId, llm, sent, send, recordDaysAgo, noSpendDaysAgo, reset, streak };
}

describe("streakFor (US-101)", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeAll(async () => {
    h = await harness("car_wash");
  });
  afterAll(() => h.t.close());
  beforeEach(() => h.reset());

  it("días seguidos hasta hoy; hoy sin anotar no corta la racha de ayer", async () => {
    await h.recordDaysAgo(3);
    await h.recordDaysAgo(2);
    await h.recordDaysAgo(1);
    expect((await h.streak()).current).toBe(3);
    expect((await h.streak()).keptToday).toBe(false);
    await h.recordDaysAgo(0);
    const s = await h.streak();
    expect(s).toMatchObject({ current: 4, best: 4, recordedToday: true });
    expect(s.last7.map((d) => d.state)).toEqual([
      "none",
      "none",
      "none",
      "recorded",
      "recorded",
      "recorded",
      "recorded",
    ]);
  });

  it("un día sin gastos mantiene la racha; con registro y sin gastos el mismo día, cuenta como anotado", async () => {
    await h.recordDaysAgo(2);
    await h.noSpendDaysAgo(1);
    await h.recordDaysAgo(0);
    await h.noSpendDaysAgo(0);
    const s = await h.streak();
    expect(s.current).toBe(3);
    expect(s.last7.slice(-3).map((d) => d.state)).toEqual(["recorded", "no_spend", "recorded"]);
  });

  it("borrado el mismo día no cuenta; borrado otro día sí", async () => {
    await h.recordDaysAgo(2, 60_000);
    await h.recordDaysAgo(1, 2 * DAY);
    expect((await h.streak()).current).toBe(1);
  });

  it("récord anterior y racha anterior", async () => {
    for (const d of [10, 9, 8, 7, 6]) await h.recordDaysAgo(d);
    await h.recordDaysAgo(1);
    await h.recordDaysAgo(0);
    const s = await h.streak();
    expect(s).toMatchObject({ current: 2, best: 5, bestBefore: 5, previous: 5 });
    // Con un hueco ayer y antier, la racha de hoy no existe todavía.
    await withTenant(h.t.db, h.tenantId, (tx) => tx.delete(schema.movement));
    await h.recordDaysAgo(3);
    expect((await h.streak()).current).toBe(0);
  });

  it("habitStats: días con registro sobre los días posibles; los días sin gastos aparte", async () => {
    await h.recordDaysAgo(2);
    await h.recordDaysAgo(0);
    await h.noSpendDaysAgo(1);
    const stats = await withTenant(h.t.db, h.tenantId, (tx) =>
      habitStats(tx, { id: h.tenantId, createdAt: new Date(Date.now() - 4 * DAY) }, new Date()),
    );
    expect(stats).toMatchObject({
      current: 3,
      recordDays28: 2,
      eligibleDays28: 5,
      noSpendDays7: 1,
      d7: null,
      d30: null,
    });
  });

  it("anotado hoy con fecha de ayer cuenta para hoy", async () => {
    await withTenant(h.t.db, h.tenantId, (tx) =>
      tx.update(schema.movement).set({ businessDate: "2000-01-01" }),
    );
    await h.recordDaysAgo(0);
    await withTenant(h.t.db, h.tenantId, (tx) =>
      tx.update(schema.movement).set({ businessDate: addDays(businessDateOf(new Date()), -1) }),
    );
    expect((await h.streak()).recordedToday).toBe(true);
  });
});

describe("hoy no gasté nada y la línea de racha (US-106, US-102)", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeAll(async () => {
    h = await harness("personal");
    await withTenant(h.t.db, h.tenantId, (tx) =>
      tx
        .update(schema.tenant)
        .set({ businessType: "personal" })
        .where(eq(schema.tenant.id, h.tenantId)),
    );
  });
  afterAll(() => h.t.close());
  beforeEach(() => h.reset());

  it("con los interruptores apagados, nada cambia: va a la IA y la tarjeta no lleva racha", async () => {
    await saveHabitSettings(h.t.db, { streakLine: false, noSpend: false }, "test", new Date());
    const calls = h.llm.calls;
    await h.send("hoy no gasté nada");
    expect(h.llm.calls).toBe(calls + 1);
    await h.recordDaysAgo(1);
    expect(await h.send("gasté 5$ en café")).not.toMatch(/🔥/);
  });

  it("H52 al dueño, una vez; el cajero va a la IA", async () => {
    await saveHabitSettings(h.t.db, { streakLine: true, noSpend: true }, "test", new Date());
    await h.recordDaysAgo(2);
    await h.recordDaysAgo(1);
    const calls = h.llm.calls;
    expect(await h.send("hoy no gasté nada")).toBe(
      "¡Tu racha sigue viva! 🔥 3 días seguidos. Hoy quedó anotado sin gastos.",
    );
    expect(h.llm.calls).toBe(calls);
    expect(await h.send("Hoy no gasté nada")).toBe("Ya lo tenía anotado. Tu racha sigue: 3 días.");
    await h.send("hoy no gasté nada", CASHIER);
    expect(h.llm.calls).toBe(calls + 1);
    // La respuesta sin gastos ya fue la línea de racha de hoy: la tarjeta no la repite.
    expect(await h.send("gasté 5$ en café")).not.toMatch(/🔥/);
  });

  it("con un registro hoy: H52c, sin anotar nada", async () => {
    await saveHabitSettings(h.t.db, { streakLine: true, noSpend: true }, "test", new Date());
    await h.recordDaysAgo(0);
    expect(await h.send("hoy no gasté nada")).toBe(
      "Hoy ya hay movimientos anotados, así que el día ya cuenta para tu racha.",
    );
    expect((await h.streak()).noSpendToday).toBe(false);
  });

  it("la línea de racha: H1a la primera vez, solo en la primera tarjeta del día y solo al dueño", async () => {
    await saveHabitSettings(h.t.db, { streakLine: true, noSpend: true }, "test", new Date());
    await h.recordDaysAgo(1);
    expect(await h.send("gasté 6$ en pan", CASHIER)).not.toMatch(/🔥/);
    const first = await h.send("gasté 5$ en café");
    expect(first).toMatch(
      /\n\n🔥 Llevas 2 días seguidos\. Cada día que anotes algo, tu racha sigue\.$/,
    );
    expect(await h.send("gasté 6$ en pan")).not.toMatch(/🔥/);
  });
});
