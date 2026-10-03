import { allTenantIds, eq, schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import { Decimal } from "../src/domain/money";
import { ingestWebhook } from "../src/inbox/ingest";
import {
  IMAGE_MAX_BYTES,
  type ProcessDeps,
  pdfPageCount,
  processInbound,
} from "../src/inbox/process";
import { sweepOrphanAttachments } from "../src/ledger/attachments";
import { MemoryObjectStore } from "../src/storage/store";
import type { ReceiptExtraction, ReceiptReader } from "../src/vision/receipt";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/** Foto de factura de punta a punta (US-B6): acuse 🧾, lectura, respaldo, borrador, Guardar y Cancelar. */
type Sent = { body: Record<string, unknown> };

function fakeMeta(bytes: number | Uint8Array = 2000, mime = "image/jpeg") {
  const payload = typeof bytes === "number" ? new Uint8Array(bytes) : bytes;
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
      return new Response(payload, {
        status: 200,
        headers: { "content-type": mime, "content-length": String(payload.byteLength) },
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
  document_type: "expense",
};

function fakeVision(
  e: ReceiptExtraction | Error,
): ReceiptReader & { calls: number; mimes: string[] } {
  return {
    provider: "fake",
    calls: 0,
    mimes: [],
    async read(_bytes, mimeType) {
      this.calls += 1;
      this.mimes.push(mimeType);
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
    const reply = (toolCalls: { id: string; name: string; input: unknown }[]) => ({
      toolCalls,
      text: null,
      stopReason: "tool_use" as const,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: "fake",
    });
    const sale =
      /Reporte de ventas leído por el sistema: total ([\d.]+) (USD|VES); fecha ([\d-]+)/.exec(text);
    if (sale)
      return reply([
        {
          id: "s1",
          name: "draft_income_day_total",
          input: {
            total_amount: sale[1],
            total_currency: sale[2],
            lines: [],
            when: sale[3],
            rate: "",
            corrects_draft: false,
          },
        },
      ]);
    if (text.includes("No es un gasto es una venta"))
      return reply([
        {
          id: "s2",
          name: "draft_income_single",
          input: {
            amount: "45",
            currency: "USD",
            method: "unspecified",
            description: "Ferretería El Tornillo",
            when: "",
            rate: "",
            corrects_draft: true,
          },
        },
      ]);
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
              corrects_draft: true,
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
                corrects_draft: false,
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
    expect(textOf(notReceipt.sent[1])).toContain("Solo proceso facturas y recibos");
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
    expect(textOf(gif.sent[1])).toContain("Solo proceso facturas y recibos");
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

  async function sendDocument(
    client: MetaClient,
    vision: ReceiptReader | null,
    doc: { mime_type?: string; filename?: string },
  ) {
    jobs.length = 0;
    const p = JSON.parse(JSON.stringify(fx.documentMessage));
    const m = p.entry[0].changes[0].value.messages[0];
    m.id = `wamid.DOC${++seq}`;
    m.document = { id: "MEDIA_IMG", sha256: "ghi", ...doc };
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    return processInbound(deps(client, vision), jobs[0] as ProcessMessageJob);
  }
  const pdf = (pages: number) =>
    new TextEncoder().encode(
      `%PDF-1.4\n1 0 obj << /Type /Pages /Count ${pages} >> endobj\n${Array.from(
        { length: pages },
        (_, i) => `${i + 2} 0 obj << /Type /Page /Parent 1 0 R >> endobj`,
      ).join("\n")}\n%%EOF`,
    );

  it("cuenta las páginas de un PDF sin confundir /Pages", () => {
    expect(pdfPageCount(pdf(1))).toBe(1);
    expect(pdfPageCount(pdf(7))).toBe(7);
    expect(pdfPageCount(new TextEncoder().encode("%PDF-1.7 comprimido"))).toBe(0);
  });

  it("un PDF de factura se lee como la foto: lectura, respaldo .pdf, borrador y Guardar", async () => {
    const { sent, client } = fakeMeta(pdf(2), "application/pdf");
    const vision = fakeVision(RECEIPT);
    const before = store.objects.size;
    await sendDocument(client, vision, { mime_type: "application/pdf", filename: "f-0042.pdf" });
    expect(vision.mimes).toEqual(["application/pdf"]);
    expect(sent[0]?.body.reaction).toMatchObject({ emoji: "🧾" });
    expect(textOf(sent[1]).startsWith("🧾 Leí la factura: Ferretería El Tornillo")).toBe(true);
    expect(store.objects.size).toBe(before + 1);
    const att = (await attachments()).at(-1);
    expect(att).toMatchObject({ mimeType: "application/pdf" });
    expect(att?.storageKey.endsWith(".pdf")).toBe(true);
    const [msg] = await withTenant(t.db, tenantId, (tx) =>
      tx
        .select()
        .from(schema.message)
        .where(eq(schema.message.waMessageId, `wamid.DOC${seq}`)),
    );
    expect(msg?.body?.startsWith("[PDF de factura] Ferretería El Tornillo")).toBe(true);
    await tap(client, vision, buttonsOf(sent[1])[0]?.id as string, "Guardar");
    const [mv] = await withTenant(t.db, tenantId, (tx) =>
      tx
        .select()
        .from(schema.movement)
        .where(eq(schema.movement.attachmentId, att?.id as string)),
    );
    expect(mv).toMatchObject({ amountUsd: "45.00" });
  });

  it("una foto mandada como documento se lee igual que una foto", async () => {
    const { sent, client } = fakeMeta(2000, "image/jpeg");
    const vision = fakeVision(RECEIPT);
    await sendDocument(client, vision, { mime_type: "image/jpeg", filename: "IMG_2041.jpg" });
    expect(vision.mimes).toEqual(["image/jpeg"]);
    expect(textOf(sent[1])).toContain("Gasto por confirmar");
    expect((await attachments()).at(-1)).toMatchObject({ mimeType: "image/jpeg" });
  });

  it("un reporte de ventas del propio negocio va a la venta del día con el PDF adjunto", async () => {
    const { sent, client } = fakeMeta(pdf(2), "application/pdf");
    const vision = fakeVision({
      ...RECEIPT,
      vendor: "Autolavado",
      total: "115.80",
      document_type: "sales",
    });
    await sendDocument(client, vision, { mime_type: "application/pdf", filename: "ventas.pdf" });
    const body = textOf(sent[1]);
    expect(body.startsWith("🧾 Leí el reporte de ventas: Autolavado · 115.80 USD")).toBe(true);
    expect(body).toContain("$115,80");
    const att = (await attachments()).at(-1);
    await tap(client, vision, buttonsOf(sent[1])[0]?.id as string, "Guardar");
    const [mv] = await withTenant(t.db, tenantId, (tx) =>
      tx
        .select()
        .from(schema.movement)
        .where(eq(schema.movement.attachmentId, att?.id as string)),
    );
    expect(mv).toMatchObject({ type: "income", origin: "day_total", amountUsd: "115.80" });
  });

  it("corregir 'no es un gasto, es una venta' conserva el PDF y no dice 'Sin especificar'", async () => {
    const { sent, client } = fakeMeta(pdf(1), "application/pdf");
    const vision = fakeVision(RECEIPT);
    await sendDocument(client, vision, { mime_type: "application/pdf", filename: "f.pdf" });
    const att = (await attachments()).at(-1);
    await tap(client, vision, buttonsOf(sent[1])[1]?.id as string, "Corregir");
    jobs.length = 0;
    const p = fx.textMessage(`wamid.SALE${++seq}`, "No es un gasto es una venta");
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    await processInbound(deps(client, vision), jobs[0] as ProcessMessageJob);
    const draft = textOf(sent.at(-1));
    expect(draft).toContain("Ingreso por confirmar");
    expect(draft).toContain("Ferretería El Tornillo: *$45,00*\n");
    expect(draft).not.toContain("Sin especificar");
    await tap(client, vision, buttonsOf(sent.at(-1))[0]?.id as string, "Guardar");
    const [mv] = await withTenant(t.db, tenantId, (tx) =>
      tx
        .select()
        .from(schema.movement)
        .where(eq(schema.movement.attachmentId, att?.id as string)),
    );
    expect(mv).toMatchObject({ type: "income", origin: "single", sourceChannel: "image" });
    expect((await attachments()).find((a) => a.id === att?.id)?.deletedAt).toBeNull();
  });

  it("Word, Excel u otros archivos: lo dice sin descargar ni leer", async () => {
    const { sent, client } = fakeMeta();
    const vision = fakeVision(RECEIPT);
    await sendDocument(client, vision, {
      mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: "presupuesto.docx",
    });
    expect(vision.calls).toBe(0);
    expect(sent).toHaveLength(1);
    expect(textOf(sent[0])).toBe(
      'No puedo leer "presupuesto.docx". De archivos solo leo facturas en PDF o en foto. Si es un gasto, escríbemelo: _gasté 15$ en champú_',
    );
  });

  it("PDF con muchas páginas, pesado o que no es PDF: no lo manda al lector", async () => {
    const vision = fakeVision(RECEIPT);
    const long = fakeMeta(pdf(6), "application/pdf");
    await sendDocument(long.client, vision, { mime_type: "application/pdf", filename: "e.pdf" });
    expect(textOf(long.sent[1])).toBe(
      "Ese PDF tiene 6 páginas y leo facturas de hasta 5. Mándame solo la factura o una foto del total.",
    );
    const big = fakeMeta(IMAGE_MAX_BYTES + 1, "application/pdf");
    await sendDocument(big.client, vision, { mime_type: "application/pdf", filename: "b.pdf" });
    expect(textOf(big.sent[1])).toContain("El PDF es muy pesado");
    const fake = fakeMeta(new TextEncoder().encode("<html>no</html>"), "application/pdf");
    await sendDocument(fake.client, vision, { mime_type: "application/pdf", filename: "x.pdf" });
    expect(textOf(fake.sent[1])).toContain("No pude leer bien la factura");
    expect(vision.calls).toBe(0);
  });
});
