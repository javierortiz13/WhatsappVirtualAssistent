import { and, eq, schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient, LlmResponse } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import { Decimal } from "../src/domain/money";
import { autoSaveDueDrafts } from "../src/inbox/autosave";
import { ingestWebhook } from "../src/inbox/ingest";
import { type ProcessDeps, processInbound } from "../src/inbox/process";
import { setBudget } from "../src/ledger/budgets";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/**
 * Autoguardado (0022): la tarjeta sale sin Guardar; si en 15 minutos nadie la corrige ni la
 * cancela, el barrido la guarda y reacciona ✅ sobre el mensaje del usuario, sin "Guardado".
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
  footer?: { text: string };
  action: { buttons: { reply: { id: string; title: string } }[] };
};
const interactive = (s: Sent | undefined) => s?.body.interactive as Interactive | undefined;
const textOf = (s: Sent | undefined) =>
  String((s?.body.text as { body?: string } | undefined)?.body ?? interactive(s)?.body.text ?? "");
const buttonsOf = (s: Sent | undefined) => interactive(s)?.action.buttons.map((b) => b.reply) ?? [];
const reactionOf = (s: Sent | undefined) =>
  s?.body.type === "reaction"
    ? (s.body.reaction as { message_id: string; emoji: string })
    : undefined;

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

const expense = (id: string, amount: string, description: string) => [
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
      corrects_draft: false,
    },
  },
];

const MIN = 60_000;

describe("autoguardado de borradores", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  const start = new Date("2026-09-29T15:00:00Z");
  let clock = start;
  const now = () => clock;
  const later = (minutes: number) => new Date(start.getTime() + minutes * MIN);
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
    "gasté 15$ en champú": expense("e1", "15", "Champú"),
    "gasté 8$ en cera": expense("e2", "8", "Cera"),
    "gasté 9$ en esponjas": expense("e3", "9", "Esponjas"),
    "gasté 4$ en trapos": expense("e4", "4", "Trapos"),
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

  async function send(client: MetaClient, body: string): Promise<string> {
    jobs.length = 0;
    const id = `wamid.A${++seq}`;
    await ingestWebhook(
      { db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) },
      fx.textMessage(id, body),
    );
    await processInbound(deps(client), jobs[0] as ProcessMessageJob);
    return id;
  }

  async function tap(client: MetaClient, id: string, title: string) {
    jobs.length = 0;
    const p = JSON.parse(JSON.stringify(fx.buttonReply));
    p.entry[0].changes[0].value.messages[0].id = `wamid.B${++seq}`;
    p.entry[0].changes[0].value.messages[0].interactive.button_reply = { id, title };
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    return processInbound(deps(client), jobs[0] as ProcessMessageJob);
  }

  const sweep = (client: MetaClient, at: Date) =>
    autoSaveDueDrafts(t.db, () => client, { now: at });

  const expenses = () =>
    withTenant(t.db, tenantId, (tx) =>
      tx
        .select()
        .from(schema.movement)
        .where(eq(schema.movement.type, "expense"))
        .orderBy(schema.movement.createdAt),
    );

  const drafts = () =>
    withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.pendingAction).orderBy(schema.pendingAction.createdAt),
    );

  it("la tarjeta sale sin Guardar; a los 15 minutos se guarda sola y reacciona ✅", async () => {
    const { sent, client } = fakeMeta();
    const source = await send(client, "gasté 15$ en champú");
    expect(textOf(sent[0])).toContain("*Gasto anotado*");
    expect(buttonsOf(sent[0]).map((b) => b.title)).toEqual(["Corregir", "Cancelar"]);
    expect(interactive(sent[0])?.footer?.text).toBe(
      "Si está bien, no hagas nada: se guarda en 15 min",
    );
    const [d] = await drafts();
    expect(d).toMatchObject({
      autoSave: true,
      sourceWaId: source,
      waNumberId: fx.PHONE_NUMBER_ID,
      status: "pending",
    });
    expect(d?.expiresAt.getTime()).toBe(later(15).getTime());

    // Antes de los 15 minutos no pasa nada.
    expect(await sweep(client, later(14))).toMatchObject({ saved: 0, expired: 0 });
    expect(await expenses()).toHaveLength(0);

    const r = await sweep(client, later(15));
    expect(r).toMatchObject({ saved: 1, expired: 0, sent: 1, failed: 0 });
    const [mv] = await expenses();
    expect(mv).toMatchObject({ description: "Champú", amountUsd: "15.00" });
    expect((await drafts())[0]?.status).toBe("confirmed");
    // Solo la reacción: ni "Guardado" ni otro texto.
    expect(sent).toHaveLength(2);
    expect(reactionOf(sent[1])).toEqual({ message_id: source, emoji: "✅" });
    const [out] = await withTenant(t.db, tenantId, (tx) =>
      tx
        .select()
        .from(schema.message)
        .where(and(eq(schema.message.direction, "out"), eq(schema.message.kind, "reaction"))),
    );
    expect(out).toMatchObject({ body: "✅", toolCalls: [{ name: "auto_save", args: {} }] });

    // Una segunda vuelta no lo guarda otra vez; un toque tardío avisa que ya quedó.
    expect(await sweep(client, later(20))).toMatchObject({ saved: 0 });
    expect(await expenses()).toHaveLength(1);
    await tap(client, buttonsOf(sent[0]).find((b) => b.title === "Cancelar")?.id ?? "", "Cancelar");
    expect(textOf(sent[2])).toContain("ya quedó guardado ✅");
    expect(await expenses()).toHaveLength(1);
  });

  it("Cancelar dentro de los 15 minutos lo descarta; Corregir sin decir qué no se guarda", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "gasté 8$ en cera");
    await tap(client, buttonsOf(sent[0]).find((b) => b.title === "Cancelar")?.id ?? "", "Cancelar");
    expect(sent[1]?.body.type).toBe("reaction");
    await send(client, "gasté 9$ en esponjas");
    // Corregir al minuto 10 le da 15 minutos más: a los 16 sigue esperando el cambio.
    clock = later(10);
    await tap(client, buttonsOf(sent[2]).find((b) => b.title === "Corregir")?.id ?? "", "Corregir");
    clock = start;
    expect(textOf(sent[3])).toContain("Dime qué cambio");
    expect(await sweep(client, later(16))).toMatchObject({ saved: 0, expired: 0 });
    // Nunca dijo qué cambiar: vence sin guardarse.
    expect(await sweep(client, later(25))).toMatchObject({ saved: 0, expired: 1, sent: 0 });
    const descriptions = (await expenses()).map((m) => m.description);
    expect(descriptions).not.toContain("Cera");
    expect(descriptions).not.toContain("Esponjas");
  });

  it("si el gasto pasa el presupuesto, el dueño recibe el aviso además del ✅", async () => {
    const { sent, client } = fakeMeta();
    const [cat] = await withTenant(t.db, tenantId, (tx) =>
      tx
        .select({ id: schema.category.id })
        .from(schema.category)
        .where(eq(schema.category.name, "Insumos de lavado")),
    );
    await withTenant(t.db, tenantId, (tx) =>
      setBudget(
        tx,
        { tenantId, userId: "11111111-1111-4111-8111-111111111111" },
        { categoryId: cat?.id as string, amountUsd: new Decimal(20), period: "monthly" },
      ),
    );
    const source = await send(client, "gasté 4$ en trapos");
    const r = await sweep(client, later(15));
    expect(r).toMatchObject({ saved: 1, sent: 2 });
    expect(reactionOf(sent[1])).toEqual({ message_id: source, emoji: "✅" });
    // $15 + $4 = $19 de $20: 95 %.
    expect(textOf(sent[2])).toContain("⚠️ Insumos de lavado: vas por el 95 %");
  });

  it("un borrador viejo (sin autoguardado) vence sin guardarse", async () => {
    const { sent, client } = fakeMeta();
    const [phone] = await withTenant(t.db, tenantId, (tx) =>
      tx.select({ id: schema.phoneNumber.id }).from(schema.phoneNumber),
    );
    const before = (await expenses()).length;
    const [old] = await withTenant(t.db, tenantId, (tx) =>
      tx
        .insert(schema.pendingAction)
        .values({
          tenantId,
          phoneId: phone?.id as string,
          kind: "create_expense",
          payload: {},
          expiresAt: later(-5),
        })
        .returning({ id: schema.pendingAction.id }),
    );
    expect(await sweep(client, later(0))).toMatchObject({ saved: 0, expired: 1, sent: 0 });
    const row = (await drafts()).find((d) => d.id === old?.id);
    expect(row?.status).toBe("expired");
    expect(await expenses()).toHaveLength(before);
    expect(sent).toHaveLength(0);
  });
});
