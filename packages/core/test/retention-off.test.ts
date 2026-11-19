import { eq, schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient, LlmResponse } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import { addDays, businessDateOf } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";
import { ingestWebhook } from "../src/inbox/ingest";
import { runHabitNudges } from "../src/inbox/nudge";
import { type ProcessDeps, processInbound } from "../src/inbox/process";
import { saveHabitSettings } from "../src/ledger/habits";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/**
 * Retención E1–E3 (agencia 19/11, pedido punto 8): con sus tres interruptores apagados, nada de
 * lo que Rocco manda cambia. La foto (`__snapshots__`) se sacó con el código de 7cd8692, antes de
 * E1–E3; esta prueba usa solo lo que ya existía entonces.
 */
const OWNER = "584121234567";
const OWNER_B = "584121234568";
const DAY = 86_400_000;

const at = (hh: number, mm: number, dayOffset = 0) => {
  const d = addDays(businessDateOf(new Date()), dayOffset);
  return new Date(`${d}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00-04:00`);
};

const llm: LlmClient = {
  model: "fake",
  async complete(req) {
    const last = req.turns[req.turns.length - 1];
    const text = last && "text" in last ? (last.text ?? "") : "";
    const calls: LlmResponse["toolCalls"] = text.includes("gasté 5$ en café")
      ? [
          {
            id: "e",
            name: "draft_expense",
            input: {
              amount: "5",
              currency: "USD",
              description: "café",
              category_name: "",
              when: "",
              rate: "",
              corrects_draft: false,
            },
          },
        ]
      : [{ id: "q", name: "ask_clarification", input: { question: "¿Qué?", options: [] } }];
    return {
      toolCalls: calls,
      text: null,
      stopReason: "tool_use" as const,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: "fake",
    };
  },
  costUsd: () => new Decimal(0),
};

/** Fechas y días de la semana fuera de la foto (la prueba corre cualquier día). */
const normalize = (s: string) =>
  s
    .replace(/\d{4}-\d{2}-\d{2}/g, "<fecha>")
    .replace(/(lun|mar|mié|jue|vie|sáb|dom) \d{2}\/\d{2}/g, "<día>")
    .replace(/wamid\.[\w.]+/g, "<wamid>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>");

describe("interruptores de retención apagados: lo saliente no cambia", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantA = "";
  let tenantB = "";
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (init?.method === "POST" && body.status !== "read") sent.push(body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT.${sent.length}` }] }), {
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
  async function deliver(p: unknown) {
    const jobs: ProcessMessageJob[] = [];
    await ingestWebhook(
      { db: t.db, now: () => new Date(), enqueue: async (_tx, job) => void jobs.push(job) },
      p,
    );
    await processInbound(deps(), jobs[0] as ProcessMessageJob);
  }
  const send = (text: string, phone = OWNER) => {
    const p = structuredClone(fx.textMessage(`wamid.H${++seq}`, text)) as unknown as {
      entry: {
        changes: { value: { messages: { from: string }[]; contacts: { wa_id: string }[] } }[];
      }[];
    };
    const v = p.entry[0]?.changes[0]?.value;
    if (v?.messages[0]) v.messages[0].from = phone;
    if (v?.contacts[0]) v.contacts[0].wa_id = phone;
    return deliver(p);
  };
  const tap = (id: string, phone = OWNER) => {
    const p = structuredClone(fx.buttonReply) as unknown as {
      entry: {
        changes: {
          value: { messages: Record<string, unknown>[]; contacts: { wa_id: string }[] };
        }[];
      }[];
    };
    const v = p.entry[0]?.changes[0]?.value;
    const m = v?.messages[0];
    if (m) {
      m.interactive = { type: "button_reply", button_reply: { id, title: "x" } };
      m.from = phone;
      m.id = `wamid.T${++seq}`;
      delete m.context;
    }
    if (v?.contacts[0]) v.contacts[0].wa_id = phone;
    return deliver(p);
  };
  const record = (tenantId: string, phoneId: string, when: Date) =>
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
        businessDate: businessDateOf(when),
        paymentMethod: "unspecified",
        origin: "single",
        sourceChannel: "text",
        createdByPhoneId: phoneId,
        createdAt: when,
      }),
    );

  beforeAll(async () => {
    t = await createTestDb();
    tenantA = await seedTenant(t.db, { name: "Ana", businessType: "personal", ownerPhone: OWNER });
    tenantB = await seedTenant(t.db, { name: "Bea", businessType: "food", ownerPhone: OWNER_B });
    for (let i = 0; i < 10; i++)
      await t.db
        .insert(schema.bcvRate)
        .values({
          effectiveDate: addDays(businessDateOf(new Date()), -i),
          rate: "200.00000000",
          source: "test",
        })
        .onConflictDoNothing();
    // Producción el 19/11: el hábito encendido; la retención (E1–E3) sin tocar (apagada).
    await saveHabitSettings(
      t.db,
      { prefs: true, nudge: true, noSpend: true, streakLine: true, dailyClose: false },
      "test",
      new Date(),
    );
  });
  afterAll(() => t.close());

  it("conversación, apagar y encender, y el mensaje de la noche: igual que antes", async () => {
    const phones = await t.db.select().from(schema.phoneNumber);
    const a = phones.find((p) => p.e164 === OWNER)?.id ?? "";
    const b = phones.find((p) => p.e164 === OWNER_B)?.id ?? "";
    await record(tenantA, a, new Date(Date.now() - 2 * DAY));
    await record(tenantA, a, new Date(Date.now() - DAY));
    await send("gasté 5$ en café");
    await send("no me recuerdes");
    await tap("pref:keep:nudges_off");
    await send("no me escribas");
    await tap("pref:keep:all_off");
    await send("mis avisos");
    await tap("pref:optin");
    await send("mis avisos");
    await send("no me recuerdes");
    await tap("pref:yes:nudges_off");
    await send("actívame los avisos");
    await send("no me escribas");
    await tap("pref:yes:all_off");
    await send("ya puedes escribirme");
    await tap(`habit:nospend:${businessDateOf(new Date())}`);
    // El mensaje de la noche al otro dueño (aceptado, racha de 2, ventana abierta).
    await t.db
      .update(schema.phoneNumber)
      .set({ nudgeOptInAt: new Date(Date.now() - 30 * DAY) })
      .where(eq(schema.phoneNumber.id, b));
    await record(tenantB, b, at(12, 0, -2));
    await record(tenantB, b, at(12, 0, -1));
    await withTenant(t.db, tenantB, (tx) =>
      tx.insert(schema.message).values({
        tenantId: tenantB,
        phoneId: b,
        direction: "in",
        kind: "text",
        body: "x",
        createdAt: at(17, 0),
      }),
    );
    await runHabitNudges(t.db, client, { now: at(20, 5) });
    expect(sent.map((s) => normalize(JSON.stringify(s)))).toMatchSnapshot();
  });
});
