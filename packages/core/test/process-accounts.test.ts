import { isNull, schema, withTenant } from "@caja/db";
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

/** Cuentas por WhatsApp (0013): crear, gastar de una cuenta, cambiar entre cuentas y ver saldos. */
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

describe("cuentas por WhatsApp", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  const now = () => new Date("2026-10-04T15:00:00Z");
  const jobs: ProcessMessageJob[] = [];
  let seq = 0;

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Ana",
      businessType: "other",
      ownerPhone: "584121234567",
    });
    await t.db
      .insert(schema.bcvRate)
      .values({ effectiveDate: "2026-10-02", rate: "866.56000000", source: "test" });
  });
  afterAll(() => t.close());

  const create = (name: string, currency: string, kind: string, opening: string) => [
    {
      id: `c-${name}`,
      name: "create_account",
      input: { name, currency, kind, opening_balance: opening },
    },
  ];

  const llm = scriptedLlm({
    "crea la cuenta Banesco": create("Banesco", "VES", "bank", "10.000"),
    "agrega mi Binance": create("Binance", "USDT", "crypto", "200"),
    "crea el efectivo": create("Efectivo", "VES", "cash", ""),
    "gasté 500 bs en pan": expense("500", "Pan"),
    "cambié 100 usdt a 970": [
      {
        id: "x1",
        name: "exchange_usdt",
        input: { action: "record", usd_amount: "100", ves_amount: "", rate: "970", when: "" },
      },
    ],
    "mis cuentas": [{ id: "a1", name: "get_accounts", input: { account: "" } }],
    "cómo va banesco": [{ id: "a2", name: "get_accounts", input: { account: "banesco" } }],
    "saqué 5.000 bs de banesco al efectivo": [
      {
        id: "t1",
        name: "transfer_between_accounts",
        input: {
          from_account: "banesco",
          to_account: "efectivo",
          amount: "5.000",
          received: "",
          rate: "",
          fee: "30",
          when: "",
        },
      },
    ],
    "compré 10 usdt con 9.800 bs": [
      {
        id: "t2",
        name: "transfer_between_accounts",
        input: {
          from_account: "",
          to_account: "",
          amount: "10",
          received: "9.800",
          rate: "",
          fee: "",
          when: "",
        },
      },
    ],
    "ese fue del efectivo": [
      {
        id: "m1",
        name: "amend_last_movement",
        input: {
          amount: "",
          currency: "keep",
          category_name: "",
          description: "",
          when: "",
          method: "keep",
          rate: "",
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
        knownMax: 1000,
      },
    };
  }

  async function send(client: MetaClient, body: string) {
    jobs.length = 0;
    const p = fx.textMessage(`wamid.AC${++seq}`, body);
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    return processInbound(deps(client), jobs[0] as ProcessMessageJob);
  }

  async function tap(client: MetaClient, id: string, title: string) {
    jobs.length = 0;
    const p = JSON.parse(JSON.stringify(fx.buttonReply));
    p.entry[0].changes[0].value.messages[0].id = `wamid.ACB${++seq}`;
    p.entry[0].changes[0].value.messages[0].interactive.button_reply = { id, title };
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    return processInbound(deps(client), jobs[0] as ProcessMessageJob);
  }

  const button = (s: Sent | undefined, title: string) => {
    const b = buttonsOf(s).find((x) => x.title === title);
    if (!b) throw new Error(`sin botón ${title}: ${JSON.stringify(buttonsOf(s))}`);
    return b.id;
  };

  it("sin cuentas, 'mis cuentas' explica cómo crearlas", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "mis cuentas");
    expect(textOf(last(sent))).toContain("Aún no tienes cuentas");
  });

  it("crear cuentas por chat", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "crea la cuenta Banesco en bolívares con 10.000");
    expect(textOf(last(sent))).toContain("✅ Creé la cuenta *Banesco* con Bs 10.000,00");
    await send(client, "agrega mi Binance con 200 usdt");
    expect(textOf(last(sent))).toContain("✅ Creé la cuenta *Binance* con 200,00 USDT");
    await send(client, "crea la cuenta Banesco otra vez");
    expect(textOf(last(sent))).toContain("Ya tienes una cuenta llamada *Banesco*");
  });

  it("un gasto en Bs sale de la cuenta principal y al guardar dice cuánto le queda", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "gasté 500 bs en pan");
    expect(textOf(last(sent))).toContain("Cuenta: Banesco");
    await tap(client, button(last(sent), "Guardar"), "Guardar");
    expect(textOf(last(sent))).toContain("💳 Banesco: *Bs 9.500,00*");
    const [mv] = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.movement));
    expect(mv?.accountId).not.toBeNull();
    // Sus Bs salieron del lote del saldo inicial aunque vaya a la BCV.
    const allocs = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.exchangeAllocation),
    );
    expect(allocs.map((a) => a.vesAmount)).toEqual(["500.00"]);
    expect(mv?.rateSource).toBe("bcv");
  });

  it("corregir la cuenta de lo guardado por chat", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "crea el efectivo en bolívares");
    // Corregir por chat es para lo guardado hace menos de 30 minutos (reloj de la prueba).
    await withTenant(t.db, tenantId, (tx) => tx.update(schema.movement).set({ createdAt: now() }));
    await send(client, "ese fue del efectivo");
    const draft = textOf(last(sent));
    expect(draft).toContain("Cuenta: Banesco → *Efectivo*");
    await tap(client, button(last(sent), "Guardar"), "Guardar");
    const [mv] = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.movement).where(isNull(schema.movement.deletedAt)),
    );
    const accounts = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.account));
    expect(accounts.find((a) => a.id === mv?.accountId)?.name).toBe("Efectivo");
  });

  it("un cambio sale de Binance y entra al banco; los dos saldos al guardar", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "cambié 100 usdt a 970");
    expect(textOf(last(sent))).toContain("De Binance → a Banesco");
    await tap(client, button(last(sent), "Guardar"), "Guardar");
    const saved = textOf(last(sent));
    expect(saved).toContain("💳 Banesco: *Bs 107.000,00*");
    expect(saved).toContain("💳 Binance: *100,00 USDT*");
    expect(saved).not.toContain("Saldo de tus cambios");
  });

  it("'mis cuentas' da cada saldo y el total con los Bs a la BCV de hoy", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "mis cuentas");
    const body = textOf(last(sent));
    expect(body).toContain("• Banesco: *Bs 107.000,00*");
    expect(body).toContain("• Binance: *100,00 USDT*");
    expect(body).toContain("• Efectivo: *−Bs 500,00*");
    // 100 + (107.000 − 500) / 866,56
    expect(body).toContain("Total: *$222,90*");
  });

  it("transferir entre cuentas en Bs con comisión", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "saqué 5.000 bs de banesco al efectivo, comisión 30");
    const draft = textOf(last(sent));
    expect(draft).toContain("*Transferencia por confirmar*");
    expect(draft).toContain("Banesco → Efectivo: *Bs 5.000,00*");
    expect(draft).toContain("Comisión: Bs 30,00 (queda como gasto de Banesco)");
    await tap(client, button(last(sent), "Guardar"), "Guardar");
    const saved = textOf(last(sent));
    expect(saved).toContain("✅ Transferencia guardada");
    expect(saved).toContain("💳 Banesco: *Bs 101.970,00*");
    expect(saved).toContain("💳 Efectivo: *Bs 4.500,00*");
  });

  it("comprar USDT con Bs: del banco a Binance, aunque el modelo dé los montos al revés", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "compré 10 usdt con 9.800 bs");
    const draft = textOf(last(sent));
    expect(draft).toContain("*Compra de USDT por confirmar*");
    expect(draft).toContain("Banesco → Binance: *Bs 9.800,00* → *10,00 USDT* (a 980,00)");
    await tap(client, button(last(sent), "Guardar"), "Guardar");
    const saved = textOf(last(sent));
    expect(saved).toContain("💳 Banesco: *Bs 92.170,00*");
    expect(saved).toContain("💳 Binance: *110,00 USDT*");
  });

  it("el detalle de una cuenta: saldo, el mes y lo último", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "cómo va banesco");
    const body = textOf(last(sent));
    expect(body).toContain("💳 *Banesco*: Bs 92.170,00");
    expect(body).toContain("• 04/10 A Binance: −Bs 9.800,00");
    expect(body).toContain("• 04/10 Comisión Banesco → Efectivo: −Bs 30,00");
    expect(body).toContain("https://caja.test/ajustes/cuentas/");
  });
});
