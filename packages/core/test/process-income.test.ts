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

/**
 * Flujo de ventas de punta a punta (US-C1, US-C3): el LLM falso elige la herramienta y el
 * procesador crea el borrador, resuelve el desglose y ejecuta con Guardar / Reemplazar.
 */
type Sent = { body: Record<string, unknown> };
const OWNER = "584121234567";

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

/** Guion: por cada fragmento del mensaje del usuario, la llamada a herramienta que "elige" el modelo. */
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

const dayTotal = (
  id: string,
  total: string | null,
  lines: { method: string; amount: string }[],
) => [
  {
    id,
    name: "draft_income_day_total",
    input: {
      total_amount: total ?? "",
      total_currency: total ? "USD" : "unknown",
      lines: lines.map((l) => ({ ...l, currency: "unknown" })),
      when: "",
      rate: "",
      corrects_draft: false,
    },
  },
];

describe("ventas por WhatsApp", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  const now = () => new Date("2026-09-29T15:00:00Z");
  const jobs: ProcessMessageJob[] = [];
  let seq = 0;

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Autolavado",
      businessType: "car_wash",
      ownerPhone: OWNER,
    });
    await t.db
      .insert(schema.bcvRate)
      .values({ effectiveDate: "2026-09-29", rate: "858.00000000", source: "test" });
  });
  afterAll(() => t.close());

  const llm = scriptedLlm({
    "hoy vendí 350$: 200 efectivo, 100 pago móvil, 50 punto": dayTotal("t1", "350", [
      { method: "cash_usd", amount: "200" },
      { method: "pago_movil", amount: "100" },
      { method: "punto", amount: "50" },
    ]),
    "hoy vendí 350$: 200 efectivo y 100 pago móvil": dayTotal("t2", "350", [
      { method: "cash_usd", amount: "200" },
      { method: "pago_movil", amount: "100" },
    ]),
    "hoy vendí 400$": dayTotal("t3", "400", []),
    "el sábado vendí 120$": [
      {
        id: "t5",
        name: "draft_income_day_total",
        input: {
          total_amount: "120",
          total_currency: "USD",
          lines: [],
          when: "2026-09-26",
          rate: "",
          corrects_draft: false,
        },
      },
    ],
    "me pagaron 30$ por zelle del carro del abogado": [
      {
        id: "t4",
        name: "draft_income_single",
        input: {
          amount: "30",
          currency: "USD",
          method: "zelle",
          description: "Carro del abogado",
          when: "",
          rate: "",
          corrects_draft: false,
        },
      },
    ],
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

  async function send(client: MetaClient, body: string) {
    jobs.length = 0;
    const p = fx.textMessage(`wamid.V${++seq}`, body);
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    return processInbound(deps(client), jobs[0] as ProcessMessageJob);
  }

  async function tap(client: MetaClient, id: string, title: string) {
    jobs.length = 0;
    const p = JSON.parse(JSON.stringify(fx.buttonReply));
    p.entry[0].changes[0].value.messages[0].id = `wamid.B${++seq}`;
    p.entry[0].changes[0].value.messages[0].interactive.button_reply = { id, title };
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    return processInbound(deps(client), jobs[0] as ProcessMessageJob);
  }

  const movements = () =>
    withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.movement).orderBy(schema.movement.createdAt),
    );

  it("total con desglose que cuadra → Guardar crea tres ingresos y responde ventas y gastos del día", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "hoy vendí 350$: 200 efectivo, 100 pago móvil, 50 punto");
    const draft = sent[0];
    expect(textOf(draft)).toContain("*Venta del día por confirmar*");
    expect(textOf(draft)).toContain("Fecha: hoy, mar 29/09");
    expect(textOf(draft)).toContain("Efectivo USD: *$200,00*");
    expect(textOf(draft)).toContain("Pago Móvil: *$100,00*");
    expect(textOf(draft)).toContain("Total: *$350,00* · Bs 300.300,00 · tasa BCV 858,00");
    const [save] = buttonsOf(draft);
    expect(save?.title).toBe("Guardar");
    await tap(client, save?.id as string, "Guardar");
    expect(textOf(sent[1])).toBe("✅ Venta guardada. Hoy: vendiste *$350,00*, gastaste *$0,00*.");
    const rows = await movements();
    expect(rows).toHaveLength(3);
    expect(rows.every((m) => m.type === "income" && m.origin === "day_total")).toBe(true);
    expect(rows.map((m) => m.paymentMethod)).toEqual(["cash_usd", "pago_movil", "punto"]);
  });

  it("segundo total del mismo día: Reemplazar da de baja el anterior", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "hoy vendí 400$");
    expect(textOf(sent[0])).toContain(
      "Ya tienes una venta del día registrada ese día por *$350,00*",
    );
    expect(buttonsOf(sent[0]).map((b) => b.title)).toEqual(["Reemplazar", "Agregar", "Cancelar"]);
    const replace = buttonsOf(sent[0])[0];
    await tap(client, replace?.id as string, "Reemplazar");
    expect(textOf(sent[1])).toContain(
      "Reemplacé la venta anterior de ese día. Hoy: vendiste *$400,00*",
    );
    const live = (await movements()).filter((m) => !m.deletedAt);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ paymentMethod: "unspecified", amountUsd: "400.00" });
  });

  it("desglose que no cuadra: botones con los dos totales; 'Total $350' agrega 'Sin especificar'", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "hoy vendí 350$: 200 efectivo y 100 pago móvil");
    expect(textOf(sent[0])).toContain("El desglose suma *$300,00* y el total es *$350,00*.");
    expect(textOf(sent[0])).toContain("Faltan *$50,00*");
    const btns = buttonsOf(sent[0]);
    expect(btns.map((b) => b.title)).toEqual(["Total $350", "Total $300", "Corregir"]);
    await tap(client, btns[0]?.id as string, "Total $350");
    expect(textOf(sent[1])).toContain("Sin especificar: *$50,00*");
    expect(textOf(sent[1])).toContain(
      "Ya tienes una venta del día registrada ese día por *$400,00*",
    );
    const append = buttonsOf(sent[1])[1];
    expect(append?.title).toBe("Agregar");
    await tap(client, append?.id as string, "Agregar");
    expect(textOf(sent[2])).toContain("Hoy: vendiste *$750,00*");
  });

  it("ingreso suelto: Guardar crea un ingreso 'single' con método y descripción", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "me pagaron 30$ por zelle del carro del abogado");
    expect(textOf(sent[0])).toContain("*Ingreso por confirmar*");
    expect(textOf(sent[0])).toContain(
      "Carro del abogado: *$30,00* por Zelle\nBs 25.740,00 · tasa BCV 858,00",
    );
    await tap(client, buttonsOf(sent[0])[0]?.id as string, "Guardar");
    expect(textOf(sent[1])).toContain("vendiste *$780,00*");
    const single = (await movements()).find((m) => m.origin === "single" && m.type === "income");
    expect(single).toMatchObject({ paymentMethod: "zelle", description: "Carro del abogado" });
  });

  it("dos borradores del mismo día: el segundo Guardar ya no suma, pregunta Reemplazar o Agregar", async () => {
    const { sent, client } = fakeMeta();
    // Los dos se arman sin venta registrada ese día (cola de borradores).
    await send(client, "el sábado vendí 120$");
    await send(client, "el sábado vendí 120$");
    await tap(client, buttonsOf(sent[0])[0]?.id as string, "Guardar");
    expect(textOf(sent[2])).toContain("✅ Venta guardada.");
    await tap(client, buttonsOf(sent[1])[0]?.id as string, "Guardar");
    expect(textOf(sent[3])).toContain(
      "Ya tienes una venta del día registrada ese día por *$120,00*",
    );
    expect(buttonsOf(sent[3]).map((b) => b.title)).toEqual(["Reemplazar", "Agregar", "Cancelar"]);
    const sat = (await movements()).filter((m) => m.businessDate === "2026-09-26" && !m.deletedAt);
    expect(sat).toHaveLength(1);
  });
});
