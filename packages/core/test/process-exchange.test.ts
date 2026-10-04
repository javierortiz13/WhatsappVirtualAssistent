import { schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient, LlmResponse } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import { Decimal } from "../src/domain/money";
import { ingestWebhook } from "../src/inbox/ingest";
import { type ProcessDeps, processInbound } from "../src/inbox/process";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/** Cambios USDT → Bs por WhatsApp (0012): registrar, elegir el modo, gastar, preguntar y saldo. */
type Sent = { body: Record<string, unknown> };

function fakeMeta() {
  const sent: Sent[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (body.status !== "read") sent.push({ body });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT.${Math.random()}` }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    sent,
    client: new MetaClient({ accessToken: "T", phoneNumberId: fx.PHONE_NUMBER_ID, fetchImpl }),
  };
}

type Interactive = {
  body: { text: string };
  action: { buttons: { reply: { id: string; title: string } }[] };
};
const interactive = (s: Sent | undefined) => s?.body.interactive as Interactive | undefined;
const textOf = (s: Sent | undefined) =>
  String((s?.body.text as { body?: string } | undefined)?.body ?? interactive(s)?.body.text ?? "");
const buttonsOf = (s: Sent | undefined) => interactive(s)?.action.buttons.map((b) => b.reply) ?? [];
const last = (sent: Sent[]) => sent[sent.length - 1];

function scriptedLlm(script: Record<string, LlmResponse["toolCalls"]>): LlmClient {
  return {
    model: "fake",
    async complete(req) {
      const lastTurn = req.turns[req.turns.length - 1];
      const text = lastTurn && "text" in lastTurn ? (lastTurn.text ?? "") : "";
      const key = Object.keys(script).find((k) => text.includes(k));
      if (!key) throw new Error(`sin guion para: ${text.slice(-80)}`);
      return {
        toolCalls: script[key] ?? [],
        text: null,
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: "fake",
      };
    },
    costUsd: () => new Decimal(0),
  };
}

const expense = (amount: string, description: string) => [
  {
    id: `e-${amount}`,
    name: "draft_expense",
    input: {
      amount,
      currency: "VES",
      description,
      category_name: "",
      when: "",
      rate: "",
      corrects_draft: false,
    },
  },
];

describe("cambios USDT por WhatsApp", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  const now = () => new Date("2026-10-04T15:00:00Z");
  const jobs: ProcessMessageJob[] = [];
  let seq = 0;

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Pedro",
      businessType: "other",
      ownerPhone: "584121234567",
    });
    await t.db
      .insert(schema.bcvRate)
      .values({ effectiveDate: "2026-10-02", rate: "866.56000000", source: "test" });
  });
  afterAll(() => t.close());

  const llm = scriptedLlm({
    "cambié 100 usdt a 970": [
      {
        id: "x1",
        name: "exchange_usdt",
        input: { action: "record", usd_amount: "100", ves_amount: "", rate: "970", when: "" },
      },
    ],
    "cambié 100 usdt a 97": [
      {
        id: "x2",
        name: "exchange_usdt",
        input: { action: "record", usd_amount: "100", ves_amount: "", rate: "97", when: "" },
      },
    ],
    "cuántos bs me quedan": [
      {
        id: "x3",
        name: "exchange_usdt",
        input: { action: "balance", usd_amount: "", ves_amount: "", rate: "", when: "" },
      },
    ],
    "9700 bs en mercado": expense("9700", "Mercado"),
    "970 bs en pan": expense("970", "Pan"),
  });

  function deps(client: MetaClient): ProcessDeps {
    return {
      db: t.db,
      metaFor: () => client,
      agent: createAgent({ llm, now }),
      now,
      config: {
        assistantName: "x",
        dashboardUrl: "https://caja.test",
        supportHint: null,
        unknownReplyMax: 5,
        unknownReplyWindowMs: 3_600_000,
        maxEventAgeMs: 12 * 3_600_000,
        maxTextLength: 500,
        knownMax: 1000,
      },
    };
  }

  async function send(client: MetaClient, body: string) {
    jobs.length = 0;
    const p = fx.textMessage(`wamid.X${++seq}`, body);
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    return processInbound(deps(client), jobs[0] as ProcessMessageJob);
  }

  async function tap(client: MetaClient, id: string, title: string) {
    jobs.length = 0;
    const p = JSON.parse(JSON.stringify(fx.buttonReply));
    p.entry[0].changes[0].value.messages[0].id = `wamid.XB${++seq}`;
    p.entry[0].changes[0].value.messages[0].interactive.button_reply = { id, title };
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    return processInbound(deps(client), jobs[0] as ProcessMessageJob);
  }

  const button = (s: Sent | undefined, title: string) => {
    const b = buttonsOf(s).find((x) => x.title === title);
    if (!b) throw new Error(`sin botón ${title}: ${JSON.stringify(buttonsOf(s))}`);
    return b.id;
  };

  it("registrar un cambio: borrador, Guardar, saldo y la pregunta del modo", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "cambié 100 usdt a 970");
    expect(textOf(last(sent))).toContain("100,00 USDT → *Bs 97.000,00*");
    await tap(client, button(last(sent), "Guardar"), "Guardar");
    const saved = textOf(last(sent));
    expect(saved).toContain("✅ Cambio guardado: 100,00 USDT → Bs 97.000,00 a 970,00.");
    expect(saved).toContain("Saldo de tus cambios: *Bs 97.000,00*");
    expect(buttonsOf(last(sent)).map((b) => b.title)).toEqual([
      "Siempre",
      "Preguntarme",
      "No, tasa BCV",
    ]);
    await tap(client, button(last(sent), "Siempre"), "Siempre");
    expect(textOf(last(sent))).toContain("siempre salen de tus cambios");
    const [tenant] = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.tenant));
    expect(tenant?.bsRateMode).toBe("usdt");
  });

  it("una tasa absurda se pregunta antes de guardar", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "cambié 100 usdt a 97");
    expect(textOf(last(sent))).toContain("¿Seguro que fue a 97,00?");
  });

  it("modo siempre: el gasto en Bs sale del cambio y dice cuánto queda", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "gasté 9700 bs en mercado");
    const draft = textOf(last(sent));
    expect(draft).toContain("$10,00 · tasa de tu cambio 970,00");
    expect(draft).toContain("Quedarán Bs 87.300,00 de tus cambios.");
    await tap(client, button(last(sent), "Guardar"), "Guardar");
    expect(textOf(last(sent))).toContain("💱 Te quedan *Bs 87.300,00* de tus cambios.");
    const allocs = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.exchangeAllocation),
    );
    expect(allocs.map((a) => a.vesAmount)).toEqual(["9700.00"]);
  });

  it("modo preguntar: primero de dónde salieron los Bs, después el borrador con Guardar", async () => {
    await withTenant(t.db, tenantId, (tx) => tx.update(schema.tenant).set({ bsRateMode: "ask" }));
    const { sent, client } = fakeMeta();
    await send(client, "gasté 970 bs en pan");
    const q = textOf(last(sent));
    expect(q).toContain("¿De dónde salieron estos *Bs 970,00* (Pan)?");
    expect(q).toContain("• Mi cambio USDT: *$1,00* (a 970,00)");
    expect(q).toContain("• Tasa BCV: *$1,12* (866,56)");
    expect(buttonsOf(last(sent)).map((b) => b.title)).toEqual([
      "Mi cambio USDT",
      "Tasa BCV",
      "Cancelar",
    ]);
    await tap(client, button(last(sent), "Mi cambio USDT"), "Mi cambio USDT");
    expect(textOf(last(sent))).toContain("$1,00 · tasa de tu cambio 970,00");
    await tap(client, button(last(sent), "Guardar"), "Guardar");
    expect(textOf(last(sent))).toContain("Te quedan *Bs 86.330,00*");
    // La otra respuesta: a la BCV, sin tocar los cambios.
    await send(client, "gasté 970 bs en pan");
    await tap(client, button(last(sent), "Tasa BCV"), "Tasa BCV");
    expect(textOf(last(sent))).toContain("$1,12 · tasa BCV 866,56");
    await tap(client, button(last(sent), "Guardar"), "Guardar");
    expect(textOf(last(sent))).not.toContain("de tus cambios");
  });

  it("el saldo por chat", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "cuántos bs me quedan");
    const body = textOf(last(sent));
    expect(body).toContain("Te quedan *Bs 86.330,00* de tus cambios:");
    expect(body).toContain("a 970,00");
    expect(body).toContain("te pregunto cada vez");
  });
});
