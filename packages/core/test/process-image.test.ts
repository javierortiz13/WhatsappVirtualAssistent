import { allTenantIds, eq, schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import { Decimal } from "../src/domain/money";
import { ingestWebhook } from "../src/inbox/ingest";
import { IMAGE_MAX_BYTES, type ProcessDeps, processInbound } from "../src/inbox/process";
import { sweepOrphanAttachments } from "../src/ledger/attachments";
import { MemoryObjectStore } from "../src/storage/store";
import type { ReceiptExtraction, ReceiptReader } from "../src/vision/receipt";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/** Foto de factura de punta a punta (US-B6): acuse 🧾, lectura, respaldo, borrador, Guardar y Cancelar. */
type Sent = { body: Record<string, unknown> };

function fakeMeta(bytes = 2000, mime = "image/jpeg") {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/MEDIA_IMG"))
      return Response.json({
        id: "MEDIA_IMG",
        url: "https://lookaside.test/img/1",
        mime_type: mime,
      });
    if (u.startsWith("https://lookaside.test/"))
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { "content-type": mime, "content-length": String(bytes) },
      });
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

const RECEIPT: ReceiptExtraction = {
  is_receipt: true,
  total: "45.00",
  currency: "USD",
  date: "2026-09-29",
  vendor: "Ferretería El Tornillo",
  line_items_count: 2,
  confidence: 0.9,
};

function fakeVision(e: ReceiptExtraction | Error): ReceiptReader & { calls: number } {
  return {
    provider: "fake",
    calls: 0,
    async read() {
      this.calls += 1;
      if (e instanceof Error) throw e;
      return {
        extraction: e,
        usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: "0.004000",
      };
    },
  };
}

const llm: LlmClient = {
  model: "fake",
  async complete(req) {
    const last = req.turns[req.turns.length - 1];
    const text = last && "text" in last ? (last.text ?? "") : "";
    if (text.includes("eran 50"))
      return {
        toolCalls: [
          {
            id: "i3",
            name: "draft_expense",
            input: {
              amount: "50",
              currency: "USD",
              description: "Ferretería El Tornillo",
              category_name: "",
              when: "",
              rate: "",
            },
          },
        ],
        text: null,
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: "fake",
      };
    const m = /total ([\d.]+) (USD|VES)/.exec(text);
    const vendor = /proveedor ([^;.]+)/.exec(text)?.[1] ?? "Factura";
    const date = /fecha (\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? "";
    return {
      toolCalls: m
        ? [
            {
              id: "i1",
              name: "draft_expense",
              input: {
                amount: m[1],
                currency: m[2],
                description: vendor.trim(),
                category_name: "",
                when: date,
                rate: "",
              },
            },
          ]
        : [
            {
              id: "i2",
              name: "ask_clarification",
              input: { question: "¿Cuánto fue?", options: [] },
            },
          ],
      text: null,
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: "fake",
    };
  },
  costUsd: () => new Decimal("0.001"),
};

describe("fotos de facturas", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  const now = () => new Date("2026-09-29T15:00:00Z");
  const jobs: ProcessMessageJob[] = [];
  let seq = 0;
  const store = new MemoryObjectStore();

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Autolavado",
      businessType: "car_wash",
      ownerPhone: "584121234567",
    });
    await t.db
      .insert(schema.bcvRate)
      .values({ effectiveDate: "2026-09-29", rate: "858.00000000", source: "test" });
  });
  afterAll(() => t.close());

  function deps(client: MetaClient, vision: ReceiptReader | null): ProcessDeps {
    return {
      db: t.db,
      metaFor: () => client,
      agent: createAgent({ llm, now }),
      vision,
      store,
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

  async function sendImage(client: MetaClient, vision: ReceiptReader | null) {
    jobs.length = 0;
    const p = JSON.parse(JSON.stringify(fx.imageMessage));
    p.entry[0].changes[0].value.messages[0].id = `wamid.IMG${++seq}`;
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    return processInbound(deps(client, vision), jobs[0] as ProcessMessageJob);
  }

  async function tap(client: MetaClient, vision: ReceiptReader | null, id: string, title: string) {
    jobs.length = 0;
    const p = JSON.parse(JSON.stringify(fx.buttonReply));
    p.entry[0].changes[0].value.messages[0].id = `wamid.IMGB${++seq}`;
    p.entry[0].changes[0].value.messages[0].interactive.button_reply = { id, title };
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    return processInbound(deps(client, vision), jobs[0] as ProcessMessageJob);
  }

  const attachments = () => withTenant(t.db, tenantId, (tx) => tx.select().from(schema.attachment));

  it("lee la factura, guarda el respaldo y manda lectura + borrador en un envío; Guardar vincula la foto", async () => {
    const { sent, client } = fakeMeta();
    const vision = fakeVision(RECEIPT);
    expect(await sendImage(client, vision)).toBe("done");
    expect(sent[0]?.body.reaction).toMatchObject({ emoji: "🧾" });
    expect(sent).toHaveLength(2);
    const body = textOf(sent[1]);
    expect(
      body.startsWith("🧾 Leí la factura: Ferretería El Tornillo · 45.00 USD · mar 29/09"),
    ).toBe(true);
    expect(body).toContain("Gasto por confirmar");
    expect(body).toContain("*$45,00*");
    expect(store.objects.size).toBe(1);
    const [att] = await attachments();
    expect(att).toMatchObject({ kind: "receipt", mimeType: "image/jpeg", sizeBytes: 2000 });
    const save = buttonsOf(sent[1])[0];
    await tap(client, vision, save?.id as string, "Guardar");
    expect(textOf(sent[2])).toContain("Gastos de hoy");
    const [mv] = await withTenant(t.db, tenantId, (tx) =>
      tx
        .select()
        .from(schema.movement)
        .where(eq(schema.movement.attachmentId, att?.id as string)),
    );
    expect(mv).toMatchObject({ sourceChannel: "image", amountUsd: "45.00" });
  });

  it("una corrección por texto o voz hereda la foto del borrador que reemplaza", async () => {
    const { sent, client } = fakeMeta();
    const vision = fakeVision(RECEIPT);
    await sendImage(client, vision);
    const before = (await attachments()).filter((a) => !a.deletedAt).length;
    jobs.length = 0;
    const p = fx.textMessage(`wamid.FIX${++seq}`, "no, eran 50");
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    await processInbound(deps(client, vision), jobs[0] as ProcessMessageJob);
    expect(textOf(sent[2])).toContain("*$50,00*");
    await tap(client, vision, buttonsOf(sent[2])[0]?.id as string, "Guardar");
    const atts = (await attachments()).filter((a) => !a.deletedAt);
    expect(atts).toHaveLength(before);
    const [mv] = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.movement).where(eq(schema.movement.amountUsd, "50.00")),
    );
    expect(mv?.attachmentId).toBe(atts[atts.length - 1]?.id);
    expect(mv?.sourceChannel).toBe("image");
  });

  it("Cancelar borra la foto provisional del bucket y la da de baja", async () => {
    const { sent, client } = fakeMeta();
    const vision = fakeVision(RECEIPT);
    await sendImage(client, vision);
    expect(store.objects.size).toBe(3);
    const cancel = buttonsOf(sent[1])[2];
    expect(cancel?.title).toBe("Cancelar");
    await tap(client, vision, cancel?.id as string, "Cancelar");
    expect(sent[2]?.body.type).toBe("reaction");
    expect(store.objects.size).toBe(2);
    const atts = await attachments();
    expect(atts.filter((a) => a.deletedAt).length).toBe(1);
  });

  it("no es factura, confianza baja o lector caído: respuestas sin respaldo", async () => {
    const notReceipt = fakeMeta();
    await sendImage(notReceipt.client, fakeVision({ ...RECEIPT, is_receipt: false }));
    expect(textOf(notReceipt.sent[1])).toContain("Solo proceso fotos de facturas y recibos");
    const low = fakeMeta();
    await sendImage(low.client, fakeVision({ ...RECEIPT, confidence: 0.3 }));
    expect(textOf(low.sent[1])).toBe("No pude leer bien la factura. ¿Cuánto fue y en qué moneda?");
    const down = fakeMeta();
    await sendImage(down.client, fakeVision(new Error("503")));
    expect(textOf(down.sent[1])).toContain("No pude leer bien la factura");
    expect(store.objects.size).toBe(2);
  });

  it("foto muy pesada o tipo no admitido; sin lector responde 'llegan pronto'", async () => {
    const big = fakeMeta(IMAGE_MAX_BYTES + 1);
    const vision = fakeVision(RECEIPT);
    await sendImage(big.client, vision);
    expect(vision.calls).toBe(0);
    expect(textOf(big.sent[1])).toContain("muy pesada");
    const gif = fakeMeta(100, "image/gif");
    await sendImage(gif.client, vision);
    expect(textOf(gif.sent[1])).toContain("Solo proceso fotos de facturas");
    const off = fakeMeta();
    await sendImage(off.client, null);
    expect(off.sent).toHaveLength(1);
    expect(textOf(off.sent[0])).toContain("Las fotos de facturas llegan pronto");
  });

  it("el barrido borra fotos provisionales viejas sin movimiento y respeta las vinculadas", async () => {
    const old = new Date(now().getTime() - 2 * 3_600_000);
    await withTenant(t.db, tenantId, (tx) =>
      tx.insert(schema.attachment).values({
        tenantId,
        kind: "receipt",
        storageKey: "t/old.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 10,
        createdAt: old,
      }),
    );
    await store.put("t/old.jpg", new Uint8Array(1), "image/jpeg");
    expect(await allTenantIds(t.db)).toContain(tenantId);
    const swept = await withTenant(t.db, tenantId, (tx) =>
      sweepOrphanAttachments(tx, store, tenantId, new Date(now().getTime() + 1), 3_600_000),
    );
    expect(swept).toBe(1);
    expect(store.objects.has("t/old.jpg")).toBe(false);
    // Las dos vinculadas a gastos guardados siguen vivas; la cancelada ya estaba de baja.
    const atts = await attachments();
    expect(atts.filter((a) => !a.deletedAt)).toHaveLength(2);
  });
});
