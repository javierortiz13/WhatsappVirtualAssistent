import { schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient, LlmResponse } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import { asIsoDate } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";
import { ingestWebhook } from "../src/inbox/ingest";
import { type ProcessDeps, processInbound } from "../src/inbox/process";
import { createAccount } from "../src/ledger/accounts";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/**
 * Cuenta de cada venta (PRD cash-in-drawer, US-012): pago móvil, punto o transferencia van al
 * banco en Bs aunque la venta se diga en $, y en un desglose de varios métodos cada renglón va por
 * su método, sin tomar el "efectivo" o el "pago móvil" de otro renglón.
 */
const OWNER = "584121234567";

function fakeMeta(): MetaClient {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ messages: [{ id: `wamid.OUT.${Math.random()}` }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  return new MetaClient({ accessToken: "T", phoneNumberId: fx.PHONE_NUMBER_ID, fetchImpl });
}

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

// Cada venta del día en otra fecha, para que ninguna pregunte Reemplazar o Agregar.
const dayTotal = (id: string, when: string, total: string, lines: [string, string][]) => [
  {
    id,
    name: "draft_income_day_total",
    input: {
      total_amount: total,
      total_currency: "USD",
      lines: lines.map(([method, amount]) => ({ method, amount, currency: "unknown" })),
      when,
      rate: "",
      corrects_draft: false,
    },
  },
];

describe("ventas: a qué cuenta va cada renglón", () => {
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
    for (const d of ["2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"])
      await t.db
        .insert(schema.bcvRate)
        .values({ effectiveDate: d, rate: "858.00000000", source: "test" });
    // BofA primero: es la principal en dólares.
    const accounts = [
      ["BofA", "USD", "bank"],
      ["Efectivo $", "USD", "cash"],
      ["Zelle", "USD", "zelle"],
      ["Banesco", "VES", "bank"],
    ] as const;
    await withTenant(t.db, tenantId, async (tx) => {
      const [phone] = await tx.select().from(schema.phoneNumber);
      for (const [name, currency, kind] of accounts)
        await createAccount(tx, {
          tenantId,
          name,
          currency,
          kind,
          openingBalance: new Decimal(0),
          openingKnown: true,
          openingDate: asIsoDate("2026-09-01"),
          actor: { phoneId: phone?.id as string },
          channel: "whatsapp",
        });
    });
  });
  afterAll(() => t.close());

  const llm = scriptedLlm({
    "hoy vendí 350$: 200 efectivo, 100 pago móvil, 50 zelle": dayTotal("t1", "2026-09-25", "350", [
      ["cash_usd", "200"],
      ["pago_movil", "100"],
      ["zelle", "50"],
    ]),
    "vendí 300$: 200 efectivo, 100 otra cosa": dayTotal("t2", "2026-09-26", "300", [
      ["cash_usd", "200"],
      ["other", "100"],
    ]),
    "vendí 20$": dayTotal("t3", "2026-09-27", "20", []),
    "vendí 30$ todo por zelle": dayTotal("t4", "2026-09-28", "30", [["other", "30"]]),
    "me pagaron 40$ por punto": [
      {
        id: "s1",
        name: "draft_income_single",
        input: {
          amount: "40",
          currency: "USD",
          method: "punto",
          description: "Lavado",
          category_name: "",
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

  /** Manda el mensaje y devuelve [monto, cuenta] de lo que guardó. */
  async function send(body: string) {
    jobs.length = 0;
    await ingestWebhook(
      { db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) },
      fx.textMessage(`wamid.S${++seq}`, body),
    );
    const before = new Set((await saved()).map((r) => r.id));
    await processInbound(deps(fakeMeta()), jobs[0] as ProcessMessageJob);
    return (await saved()).filter((r) => !before.has(r.id)).map((r) => [r.amount, r.account]);
  }

  const saved = () =>
    withTenant(t.db, tenantId, async (tx) => {
      const names = new Map(
        (await tx.select().from(schema.account)).map((a) => [a.id, a.name] as const),
      );
      return (await tx.select().from(schema.movement).orderBy(schema.movement.createdAt)).map(
        (m) => ({ id: m.id, amount: m.amount, account: names.get(m.accountId ?? "") ?? null }),
      );
    });

  it("el pago móvil de una venta en $ va al banco en Bs; cada renglón por su método", async () => {
    expect(await send("hoy vendí 350$: 200 efectivo, 100 pago móvil, 50 zelle")).toEqual([
      ["200.00", "Efectivo $"],
      ["100.00", "Banesco"],
      ["50.00", "Zelle"],
    ]);
  });

  it("un renglón sin método no toma el 'efectivo' de otro renglón: va a la principal", async () => {
    expect(await send("hoy vendí 300$: 200 efectivo, 100 otra cosa")).toEqual([
      ["200.00", "Efectivo $"],
      ["100.00", "BofA"],
    ]);
  });

  it("sin desglose o con un solo renglón, como antes: la principal, o lo que dice el mensaje", async () => {
    expect(await send("hoy vendí 20$")).toEqual([["20.00", "BofA"]]);
    expect(await send("ayer vendí 30$ todo por zelle")).toEqual([["30.00", "Zelle"]]);
  });

  it("una venta suelta por punto va al banco en Bs", async () => {
    expect(await send("me pagaron 40$ por punto")).toEqual([["40.00", "Banesco"]]);
  });
});
