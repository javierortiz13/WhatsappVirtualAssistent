import { eq, schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient, LlmRequest, LlmResponse } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import { Decimal } from "../src/domain/money";
import { ingestWebhook } from "../src/inbox/ingest";
import { type ProcessDeps, processInbound } from "../src/inbox/process";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/**
 * Reinyección de listas (S2): los botones `currency:` y `cat:` vuelven al agente como respuesta
 * a la pregunta anterior, con el historial de la conversación.
 */
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

const expense = (over: Record<string, unknown>) => ({
  amount: "500",
  currency: "unknown",
  description: "Luz",
  category_name: "",
  when: "",
  rate: "",
  corrects_draft: false,
  ...over,
});

describe("reinyección de botones de moneda y categoría", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  const now = () => new Date("2026-09-29T15:00:00Z");
  const jobs: ProcessMessageJob[] = [];
  const requests: LlmRequest[] = [];
  let seq = 0;

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Autolavado",
      businessType: "car_wash",
      ownerPhone: "584121234567",
    });
    // Sin moneda por defecto: la única situación en la que el bot pregunta la moneda.
    await withTenant(t.db, tenantId, (tx) =>
      tx
        .update(schema.tenant)
        .set({ defaultExpenseCurrency: null })
        .where(eq(schema.tenant.id, tenantId)),
    );
    await t.db
      .insert(schema.bcvRate)
      .values({ effectiveDate: "2026-09-29", rate: "858.00000000", source: "test" });
  });
  afterAll(() => t.close());

  /** El "modelo" decide por el último turno del usuario y guarda cada petición para inspeccionarla. */
  const llm: LlmClient = {
    model: "fake",
    async complete(req) {
      requests.push(req);
      const last = req.turns[req.turns.length - 1];
      const text = last && "text" in last ? (last.text ?? "") : "";
      let input: Record<string, unknown>;
      if (text.includes("pagué 500 de luz")) input = expense({});
      else if (text.includes("botón de moneda: dólares")) input = expense({ currency: "USD" });
      else if (text.includes("botón de categoría")) {
        const m = /categoría: \\?"([^"\\]+)\\?"/.exec(text);
        input = expense({ currency: "USD", category_name: m?.[1] ?? "" });
      } else throw new Error(`sin guion para: ${text.slice(-120)}`);
      return {
        toolCalls: [{ id: `c${++seq}`, name: "draft_expense", input }],
        text: null,
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: "fake",
      } satisfies LlmResponse;
    },
    costUsd: () => new Decimal(0),
  };

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
      },
    };
  }

  async function send(client: MetaClient, body: string) {
    jobs.length = 0;
    const p = fx.textMessage(`wamid.L${++seq}`, body);
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    return processInbound(deps(client), jobs[0] as ProcessMessageJob);
  }

  async function tap(client: MetaClient, id: string, title: string) {
    jobs.length = 0;
    const p = JSON.parse(JSON.stringify(fx.buttonReply));
    p.entry[0].changes[0].value.messages[0].id = `wamid.LB${++seq}`;
    p.entry[0].changes[0].value.messages[0].interactive.button_reply = { id, title };
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    return processInbound(deps(client), jobs[0] as ProcessMessageJob);
  }

  it("moneda ambigua: botones Dólares / Bolívares; el toque vuelve al agente con el historial", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "pagué 500 de luz");
    expect(textOf(sent[0])).toBe("¿500 en qué moneda?");
    expect(buttonsOf(sent[0])).toEqual([
      { id: "currency:USD", title: "Dólares" },
      { id: "currency:VES", title: "Bolívares" },
    ]);
    const usd = buttonsOf(sent[0])[0];
    await tap(client, usd?.id as string, usd?.title as string);
    expect(textOf(sent[1])).toContain("Gasto por confirmar");
    expect(textOf(sent[1])).toContain("*$500,00*");
    // El agente vio el mensaje original y la pregunta antes de la respuesta al botón.
    const last = requests[requests.length - 1];
    const texts = (last?.turns ?? []).map((tu) => ("text" in tu ? (tu.text ?? "") : ""));
    expect(texts.some((x) => x.includes("pagué 500 de luz"))).toBe(true);
    expect(texts.some((x) => x.includes("¿500 en qué moneda?"))).toBe(true);
    expect(texts[texts.length - 1]).toContain("botón de moneda: dólares (USD)");
  });

  it("cat:<id> vuelve al agente con el nombre de la categoría; un id ajeno no", async () => {
    const cats = await withTenant(t.db, tenantId, (tx) =>
      tx.select({ id: schema.category.id, name: schema.category.name }).from(schema.category),
    );
    const cat = cats.find((c) => c.name !== "Otros") ?? cats[0];
    const { sent, client } = fakeMeta();
    await tap(client, `cat:${cat?.id}`, cat?.name as string);
    expect(textOf(sent[0])).toContain("Gasto por confirmar");
    expect(textOf(sent[0])).toContain(cat?.name as string);
    const bad = fakeMeta();
    await tap(bad.client, "cat:00000000-0000-4000-8000-000000000000", "X");
    expect(textOf(bad.sent[0])).toContain("No encontré esa categoría");
  });
});
