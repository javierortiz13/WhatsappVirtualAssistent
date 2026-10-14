import { and, eq, isNull, schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient, LlmResponse } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import { Decimal } from "../src/domain/money";
import { ingestWebhook } from "../src/inbox/ingest";
import { type ProcessDeps, processInbound } from "../src/inbox/process";
import { expirePendingActions } from "../src/ledger/drafts";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/**
 * Guardado al instante (0023): el gasto se guarda en el mismo turno, la tarjeta trae los totales
 * del día y queda abierta para Corregir (reemplaza) o Deshacer (borra). El cierre de caja y los
 * totales ven el gasto de una vez, sin esperar.
 */
type Sent = { body: Record<string, unknown> };
const OWNER = "584121234567";
const MIN = 60_000;

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
const button = (s: Sent | undefined, title: string) =>
  buttonsOf(s).find((b) => b.title === title)?.id ?? "";

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

const expense = (id: string, amount: string, description: string, corrects = false) => [
  {
    id,
    name: "draft_expense",
    input: {
      amount,
      currency: "USD",
      description,
      category_name: "Insumos de lavado",
      when: "",
      rate: "",
      corrects_draft: corrects,
    },
  },
];

describe("guardado al instante", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  const start = new Date("2026-09-29T15:00:00Z");
  let clock = start;
  const now = () => clock;
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
    await withTenant(t.db, tenantId, (tx) => tx.update(schema.tenant).set({ bsRateMode: "usdt" }));
  });
  afterAll(() => t.close());

  const llm = scriptedLlm({
    "gasté 15$ en champú": expense("e1", "15", "Champú"),
    "gasté 8$ en cera": expense("e2", "8", "Cera"),
    "no, eran 10": expense("e3", "10", "Cera", true),
    "gasté 4$ en trapos": expense("e4", "4", "Trapos"),
    "eran 6": expense("e5", "6", "Trapos", true),
    "cambié 100 usdt a 970": [
      {
        id: "x1",
        name: "exchange_usdt",
        input: { action: "record", usd_amount: "100", ves_amount: "", rate: "970", when: "" },
      },
    ],
    "gasté 970 bs en pan": [
      {
        id: "p1",
        name: "draft_expense",
        input: {
          amount: "970",
          currency: "VES",
          description: "Pan",
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

  async function send(client: MetaClient, body: string) {
    jobs.length = 0;
    await ingestWebhook(
      { db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) },
      fx.textMessage(`wamid.I${++seq}`, body),
    );
    return processInbound(deps(client), jobs[0] as ProcessMessageJob);
  }

  async function tap(client: MetaClient, id: string, title: string) {
    jobs.length = 0;
    const p = JSON.parse(JSON.stringify(fx.buttonReply));
    p.entry[0].changes[0].value.messages[0].id = `wamid.IB${++seq}`;
    p.entry[0].changes[0].value.messages[0].interactive.button_reply = { id, title };
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    return processInbound(deps(client), jobs[0] as ProcessMessageJob);
  }

  const live = (description: string) =>
    withTenant(t.db, tenantId, (tx) =>
      tx
        .select()
        .from(schema.movement)
        .where(
          and(eq(schema.movement.description, description), isNull(schema.movement.deletedAt)),
        ),
    );

  it("el gasto queda guardado en el mismo mensaje y los totales lo ven de una vez", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "gasté 15$ en champú");
    expect(sent).toHaveLength(1);
    const card = textOf(sent[0]);
    expect(card).toContain("✅ *Gasto guardado*");
    expect(card).toContain("Champú: *$15,00*");
    expect(card).toContain("Gastos de hoy: *$15,00* (1 registro).");
    expect(buttonsOf(sent[0]).map((b) => b.title)).toEqual(["Corregir", "Deshacer"]);
    expect(await live("Champú")).toHaveLength(1);
    // El siguiente gasto ya cuenta el anterior: no hay que esperar ni tocar nada.
    await send(client, "gasté 8$ en cera");
    expect(textOf(sent[1])).toContain("Gastos de hoy: *$23,00* (2 registros).");
    // Un Guardar de más (tarjeta vieja) no lo duplica.
    await tap(client, `confirm:${button(sent[0], "Corregir").slice(4)}`, "Guardar");
    expect(textOf(sent[2])).toContain("ya quedó guardado");
    expect(await live("Champú")).toHaveLength(1);
  });

  it("Corregir y el cambio reemplazan el gasto guardado, sin otra confirmación", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "gasté 4$ en trapos");
    await tap(client, button(sent[0], "Corregir"), "Corregir");
    expect(textOf(sent[1])).toContain("Dime qué cambio");
    await send(client, "eran 6");
    const fixed = textOf(sent[2]);
    expect(fixed).toContain("✏️ Corregido: reemplacé el anterior.");
    expect(fixed).toContain("✅ *Gasto guardado*");
    expect(fixed).toContain("Trapos: *$6,00*");
    const trapos = await live("Trapos");
    expect(trapos.map((m) => m.amount)).toEqual(["6.00"]);
    // Escribir la corrección sin tocar Corregir también vale dentro de los 15 minutos: corrige
    // el registro más reciente (aquí los trapos pasan a ser la cera de $10).
    await send(client, "no, eran 10");
    expect(textOf(sent[3])).toContain("Cera: *$10,00*");
    expect(textOf(sent[3])).not.toContain("Trapos");
  });

  it("Deshacer lo borra al instante (a la papelera); un segundo toque lo dice", async () => {
    const { sent, client } = fakeMeta();
    clock = new Date(start.getTime() + 20 * MIN);
    await send(client, "gasté 15$ en champú");
    const ids = (await live("Champú")).map((m) => m.id);
    expect(ids).toHaveLength(2);
    await tap(client, button(sent[0], "Deshacer"), "Deshacer");
    expect(sent[1]?.body.type).toBe("reaction");
    expect(sent[1]?.body.reaction).toMatchObject({ emoji: "🗑️" });
    expect(await live("Champú")).toHaveLength(1);
    await tap(client, button(sent[0], "Deshacer"), "Deshacer");
    expect(textOf(sent[2])).toContain("Ese ya no está: lo corregiste o lo deshiciste");
    clock = start;
  });

  it("pasados los 15 minutos, Corregir reabre la tarjeta y el cambio la reemplaza", async () => {
    const { sent, client } = fakeMeta();
    clock = new Date(start.getTime() + 40 * MIN);
    await send(client, "gasté 4$ en trapos");
    await withTenant(t.db, tenantId, (tx) =>
      expirePendingActions(tx, new Date(clock.getTime() + 16 * MIN)),
    );
    const [card] = await withTenant(t.db, tenantId, (tx) =>
      tx
        .select()
        .from(schema.pendingAction)
        .where(eq(schema.pendingAction.id, button(sent[0], "Corregir").slice(4))),
    );
    expect(card?.status).toBe("confirmed");
    clock = new Date(clock.getTime() + 20 * MIN);
    await tap(client, button(sent[0], "Corregir"), "Corregir");
    expect(textOf(sent[1])).toContain("Dime qué cambio");
    await send(client, "eran 6");
    expect(textOf(sent[2])).toContain("Trapos: *$6,00*");
    // El de $4 se borró y quedó el de $6 (los trapos de antes los reemplazó "no, eran 10").
    expect((await live("Trapos")).map((m) => m.amount)).toEqual(["6.00"]);
    clock = start;
  });

  it("un cambio se deshace; si un gasto ya usó sus Bs, lo explica y no lo borra", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "cambié 100 usdt a 970");
    expect(textOf(sent[0])).toContain("✅ *Cambio guardado*");
    expect(buttonsOf(sent[0]).map((b) => b.title)).toEqual(["Deshacer"]);
    const undo = button(sent[0], "Deshacer");
    await send(client, "gasté 970 bs en pan");
    expect(textOf(sent[1])).toContain("tasa de tu cambio 970,00");
    await tap(client, undo, "Deshacer");
    expect(textOf(sent[2])).toContain("No puedo deshacer ese cambio");
    // Deshecho el gasto, el cambio ya se puede deshacer.
    await tap(client, button(sent[1], "Deshacer"), "Deshacer");
    await tap(client, undo, "Deshacer");
    expect(sent[4]?.body.type).toBe("reaction");
    const lots = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.exchangeLot).where(isNull(schema.exchangeLot.deletedAt)),
    );
    expect(lots).toHaveLength(0);
  });
});
