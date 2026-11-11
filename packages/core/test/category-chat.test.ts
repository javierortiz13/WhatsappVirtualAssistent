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
import { IDS, parseReplyId } from "../src/render/index";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/** Crear una categoría por chat (11/11, pedido del fundador), de punta a punta. */
type Sent = { body: Record<string, unknown> };
type Interactive = {
  body: { text: string };
  action: { buttons: { reply: { id: string; title: string } }[] };
};
const interactive = (s: Sent | undefined) => s?.body.interactive as Interactive | undefined;
const textOf = (s: Sent | undefined) =>
  String((s?.body.text as { body?: string } | undefined)?.body ?? interactive(s)?.body.text ?? "");
const buttonsOf = (s: Sent | undefined) => interactive(s)?.action.buttons.map((b) => b.reply) ?? [];

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

const expense = (id: string, over: Record<string, unknown> = {}) => [
  {
    id,
    name: "draft_expense",
    input: {
      amount: "15",
      currency: "USD",
      description: "Champú",
      category_name: "Insumos de lavado",
      when: "",
      rate: "",
      corrects_draft: false,
      ...over,
    },
  },
];
const del = (id: string, scope: string, count = 0, description = "") => ({
  id,
  name: "delete_last_movement",
  input: { scope, count, description },
});
const amend = (id: string, over: Record<string, unknown>) => [
  {
    id,
    name: "amend_last_movement",
    input: {
      amount: "",
      currency: "keep",
      category_name: "",
      description: "",
      when: "",
      method: "keep",
      rate: "",
      corrects_draft: false,
      ...over,
    },
  },
];

function scriptedLlm(script: Record<string, LlmResponse["toolCalls"]>): LlmClient {
  return {
    model: "claude-sonnet-5-5",
    async complete(req) {
      const last = req.turns[req.turns.length - 1];
      const text = last && "text" in last ? (last.text ?? "") : "";
      // El mensaje del usuario va al final del turno; el borrador en corrección antes.
      const msg = text.split("Mensaje del usuario: ")[1] ?? "";
      const key = Object.keys(script).find((k) => msg.includes(k));
      if (!key) throw new Error(`sin guion para: ${msg}`);
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

const create = (id: string, name: string, apply: boolean, kind = "expense") => [
  { id, name: "create_category", input: { name, kind, apply_to_last: apply } },
];

describe("parseReplyId: catnew", () => {
  it("«Sí, créala» lleva el gasto y el nombre; «No» va solo", () => {
    const id = "6f1c2a3b-4d5e-4f60-8a71-b2c3d4e5f607";
    expect(parseReplyId(IDS.categoryNew(id, "Pago de deudas"))).toEqual({
      kind: "category_new",
      movementId: id,
      name: "Pago de deudas",
    });
    expect(parseReplyId(IDS.categoryNewNo())).toEqual({ kind: "category_new_no" });
    expect(parseReplyId("catnew:no-uuid:Algo").kind).toBe("unknown");
    expect(parseReplyId(`catnew:${id}:x`).kind).toBe("unknown");
  });
});

describe("crear una categoría por chat", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  const clock = new Date("2026-09-29T15:00:00Z");
  const now = () => clock;
  const jobs: ProcessMessageJob[] = [];
  let seq = 0;

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Autolavado",
      businessType: "car_wash",
      ownerPhone: "584121234567",
    });
    await t.db
      .insert(schema.bcvRate)
      .values([{ effectiveDate: "2026-09-29", rate: "858.00000000", source: "test" }]);
  });
  afterAll(() => t.close());

  const llm = scriptedLlm({
    "gasté 38$ en la tarjeta": expense("e1", { amount: "38", description: "Pago de tarjeta" }),
    "crea una nueva que se llame pago de deudas": create("c1", "pago de deudas", true),
    "crea la categoría mascotas": create("c2", "mascotas", false),
    "otra vez la categoría mascotas": create("c3", "Mascotas", false),
    "es regalos": amend("a1", { category_name: "Regalos" }),
    "Cambia la categoría de mi último gasto": amend("a2", { category_name: "Regalos" }),
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
    await ingestWebhook(
      { db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) },
      fx.textMessage(`wamid.C${++seq}`, body),
    );
    return processInbound(deps(client), jobs[0] as ProcessMessageJob);
  }
  async function tap(client: MetaClient, id: string, title: string) {
    jobs.length = 0;
    const p = JSON.parse(JSON.stringify(fx.buttonReply));
    p.entry[0].changes[0].value.messages[0].id = `wamid.CB${++seq}`;
    p.entry[0].changes[0].value.messages[0].interactive.button_reply = { id, title };
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    return processInbound(deps(client), jobs[0] as ProcessMessageJob);
  }
  const categoryOfLast = async () =>
    withTenant(t.db, tenantId, async (tx) => {
      const [m] = await tx
        .select({ categoryId: schema.movement.categoryId })
        .from(schema.movement)
        .orderBy(schema.movement.createdAt);
      const [c] = await tx
        .select({ name: schema.category.name })
        .from(schema.category)
        .where(eq(schema.category.id, m?.categoryId as string));
      return c?.name;
    });
  const categories = () =>
    withTenant(t.db, tenantId, (tx) =>
      tx.select({ name: schema.category.name }).from(schema.category),
    );

  it("«crea una nueva que se llame pago de deudas» al corregir: la crea y propone el cambio", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "gasté 38$ en la tarjeta");
    expect(textOf(sent[0])).toContain("✅ *Gasto guardado*");
    await send(client, "Categoría crea una nueva que se llame pago de deudas");
    const card = sent.at(-1);
    expect(textOf(card)).toMatch(
      /^Listo, creé la categoría \*Pago de deudas\*\.\n\nCambio el último gasto:/,
    );
    expect(textOf(card)).toContain("→ *Pago de deudas*");
    expect(buttonsOf(card).map((b) => b.title)).toEqual(["Guardar", "Cancelar"]);
    await tap(client, fx.saveIdFrom(buttonsOf(card)), "Guardar");
    expect(await categoryOfLast()).toBe("Pago de deudas");
    // Queda en la bitácora como hecha desde WhatsApp por el teléfono del dueño.
    const [a] = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.auditLog).where(eq(schema.auditLog.entity, "category")),
    );
    expect(a).toMatchObject({ actorType: "phone", channel: "whatsapp", action: "create" });
  });

  it("«crea la categoría mascotas» solo la crea; la segunda vez dice que ya existía", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "crea la categoría mascotas");
    expect(textOf(sent.at(-1))).toBe(
      "Listo, creé la categoría *Mascotas*. Para usarla: _gasté 20$ en mascotas_, o al corregir un gasto: _es mascotas_.",
    );
    await send(client, "otra vez la categoría mascotas");
    expect(textOf(sent.at(-1))).toBe(
      "Ya tenías la categoría *Mascotas*. La uso cuando la nombres.",
    );
    const names = (await categories()).map((c) => c.name).filter((n) => n === "Mascotas");
    expect(names).toHaveLength(1);
  });

  it("corregir a una categoría que no existe: «No» no crea nada; «Sí, créala» la crea y propone el cambio", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "es regalos");
    const offer = sent.at(-1);
    expect(textOf(offer)).toBe("No tengo la categoría *Regalos*. ¿La creo y paso ahí este gasto?");
    expect(buttonsOf(offer).map((b) => b.title)).toEqual(["Sí, créala", "No"]);
    const [yes, no] = buttonsOf(offer);
    await tap(client, no?.id as string, "No");
    expect(textOf(sent.at(-1))).toBe(
      "Listo, no la creé. Dime a cuál categoría lo paso, o escribe *ayuda*.",
    );
    expect((await categories()).some((c) => c.name === "Regalos")).toBe(false);
    await tap(client, yes?.id as string, "Sí, créala");
    const card = sent.at(-1);
    expect(textOf(card)).toContain("→ *Regalos*");
    await tap(client, fx.saveIdFrom(buttonsOf(card)), "Guardar");
    expect(await categoryOfLast()).toBe("Regalos");
  });

  it("«Sí, créala» de un gasto que ya no es el último: la crea, pero no cambia nada", async () => {
    const { sent, client } = fakeMeta();
    const other = "6f1c2a3b-4d5e-4f60-8a71-b2c3d4e5f607";
    await tap(client, IDS.categoryNew(other, "Viajes"), "Sí, créala");
    expect(textOf(sent.at(-1))).toBe(
      "Listo, creé la categoría *Viajes*. Ese gasto ya no lo puedo cambiar por aquí; lo corriges en https://caja.test/movimientos",
    );
    expect((await categories()).some((c) => c.name === "Viajes")).toBe(true);
    expect(await categoryOfLast()).toBe("Regalos");
  });
});
