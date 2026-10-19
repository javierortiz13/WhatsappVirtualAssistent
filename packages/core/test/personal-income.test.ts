import { eq, schema, withTenant } from "@caja/db";
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

/**
 * Cuentas personales (19/10): lo que entra es un ingreso con su fuente (salario, freelance…), no
 * una venta. Las fuentes se crean solas; el cierre dice "Ingresos" por fuente.
 */
const OWNER = "584121234567";

type Sent = Record<string, unknown>;
function fakeMeta(sent: Sent[]): MetaClient {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Sent) : {};
    if (body.status !== "read") sent.push(body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT.${Math.random()}` }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return new MetaClient({ accessToken: "T", phoneNumberId: fx.PHONE_NUMBER_ID, fetchImpl });
}
const textOf = (s: Sent | undefined) =>
  String(
    (s?.text as { body?: string } | undefined)?.body ??
      (s?.interactive as { body?: { text?: string } } | undefined)?.body?.text ??
      "",
  );
const buttonTitles = (s: Sent | undefined) =>
  (
    (s?.interactive as { action?: { buttons?: { reply: { title: string } }[] } } | undefined)
      ?.action?.buttons ?? []
  ).map((b) => b.reply.title);

function scriptedLlm(script: Record<string, LlmResponse["toolCalls"]>): LlmClient {
  return {
    model: "claude-sonnet-5-5",
    async complete(req) {
      const last = req.turns[req.turns.length - 1];
      const text = last && "text" in last ? (last.text ?? "") : "";
      const key = Object.keys(script).find((k) => text.includes(k));
      if (!key) throw new Error(`sin guion para: ${text.slice(-80)}`);
      return {
        toolCalls: script[key] ?? [],
        text: null,
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: "claude-sonnet-5-5",
      };
    },
    costUsd: () => new Decimal(0),
  };
}

const income = (id: string, amount: string, description: string, source: string) => [
  {
    id,
    name: "draft_income_single",
    input: {
      amount,
      currency: "USD",
      method: "unspecified",
      description,
      category_name: source,
      when: "",
      rate: "",
      corrects_draft: false,
    },
  },
];
const summary = (id: string, category: string) => [
  {
    id,
    name: "get_summary",
    input: { period: category ? "this_month" : "today", from: "", to: "", category_name: category },
  },
];

describe("cuenta personal: ingresos por fuente", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  const now = () => new Date("2026-10-19T15:00:00Z");
  const jobs: ProcessMessageJob[] = [];
  let seq = 0;

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Javier",
      businessType: "personal",
      ownerPhone: OWNER,
    });
    await t.db
      .insert(schema.bcvRate)
      .values({ effectiveDate: "2026-10-19", rate: "1000.00000000", source: "test" });
  });
  afterAll(() => t.close());

  const llm = scriptedLlm({
    "me pagaron el sueldo": income("i1", "300", "Sueldo de octubre", "Salario"),
    "cobré 80$ de un diseño": income("i2", "80", "Diseño de logo", "freelance"),
    "me encontré 5$": income("i3", "5", "Billete en la calle", "cosas raras"),
    "cuánto me entró de freelance": summary("q1", "freelance"),
    cierre: summary("q2", ""),
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
      },
    };
  }

  async function send(body: string) {
    jobs.length = 0;
    const sent: Sent[] = [];
    await ingestWebhook(
      { db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) },
      fx.textMessage(`wamid.P${++seq}`, body),
    );
    await processInbound(deps(fakeMeta(sent)), jobs[0] as ProcessMessageJob);
    return sent;
  }

  const sources = () =>
    withTenant(t.db, tenantId, (tx) =>
      tx
        .select({ id: schema.category.id, name: schema.category.name })
        .from(schema.category)
        .where(eq(schema.category.kind, "income"))
        .orderBy(schema.category.sortOrder),
    );

  it("el sueldo se guarda como ingreso de Salario; las fuentes se crean solas", async () => {
    const sent = await send("me pagaron el sueldo, 300$");
    expect((await sources()).map((c) => c.name)).toEqual([
      "Salario",
      "Freelance",
      "Negocio propio",
      "Remesas",
      "Bonos y extras",
      "Alquileres",
      "Otros ingresos",
    ]);
    const card = textOf(sent[0]);
    expect(card).toContain("✅ *Ingreso guardado*");
    expect(card).toContain("Fuente: Salario");
    expect(card).toContain("Hoy: te entraron *$300,00*, gastaste *$0,00*.");
    expect(card).not.toContain("vendiste");
    const [mv] = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.movement).where(eq(schema.movement.description, "Sueldo de octubre")),
    );
    const salario = (await sources()).find((c) => c.name === "Salario");
    expect(mv?.type).toBe("income");
    expect(mv?.categoryId).toBe(salario?.id);
  });

  it("la fuente dicha con otras palabras se reconoce; si ninguna sirve, Otros ingresos", async () => {
    expect(textOf((await send("cobré 80$ de un diseño"))[0])).toContain("Fuente: Freelance");
    expect(textOf((await send("me encontré 5$"))[0])).toContain("Fuente: Otros ingresos");
  });

  it("el cierre dice Ingresos por fuente, sin ventas ni 'Ventas en efectivo'", async () => {
    const body = textOf((await send("cierre"))[0]);
    expect(body).toContain(
      "*Ingresos: $385,00*\nSalario $300,00\nFreelance $80,00\nOtros ingresos $5,00",
    );
    expect(body).toContain("*Ingresos menos gastos: $385,00*");
    expect(body).not.toContain("Ventas");
  });

  it("cuánto me entró de una fuente: total, lista y enlace a los ingresos de esa fuente", async () => {
    const body = textOf((await send("cuánto me entró de freelance"))[0]);
    expect(body).toContain("Freelance, octubre (1 al 19): *$80,00* (Bs 80.000,00) en 1 ingreso.");
    expect(body).toContain("lun 19/10 · Diseño de logo · $80,00");
    expect(body).toContain("/movimientos?mes=2026-10&tipo=income&categoria=");
  });

  it("el menú ofrece Registrar ingreso, y la ayuda da ejemplos de sueldo y freelance", async () => {
    expect(buttonTitles((await send("menu"))[0])).toEqual([
      "Registrar gasto",
      "Registrar ingreso",
      "Ver cierre",
    ]);
    const help = textOf((await send("ayuda"))[0]);
    expect(help).toContain("Registrar ingresos: _me pagaron el sueldo, 300$_");
    expect(help).not.toContain("Registrar ventas");
  });
});
