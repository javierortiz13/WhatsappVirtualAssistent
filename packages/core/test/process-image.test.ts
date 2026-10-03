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
    if (text.includes("es la descripción de esa foto"))
      return reply([
        {
          id: "d1",
          name: "draft_expense",
          input: {
            amount: "45.00",
            currency: "USD",
            description: "Cepillos y pala",
            category_name: "",
            when: "",
            rate: "",
            corrects_draft: true,
          },
        },
      ]);
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
    const pm =
      /Datos de pago móvil leídos por el sistema: el usuario va a PAGAR ([\d.]+) (USD|VES)/.exec(
        text,
      );
    if (pm)
      return reply([
        {
          id: "p1",
          name: "draft_expense",
          input: {
            amount: pm[1],
            currency: pm[2],
            description: /description = \\?"([^"\\]+)/.exec(text)?.[1] ?? "Pago móvil",
            category_name: "",
            when: "",
            rate: "",
            corrects_draft: false,
          },
        },
      ]);
    if (text.includes("DATOS de un pago móvil")) {
      const said = /Mensaje del usuario: "([\d.]+) bs del (\w+)"/i.exec(text);
      return reply([
        said
          ? {
              id: "p2",
              name: "draft_expense",
              input: {
                amount: said[1],
                currency: "VES",
                description: said[2],
                category_name: "",
                when: "",
                rate: "",
                corrects_draft: false,
              },
            }
          : {
              id: "p3",
              name: "ask_clarification",
              input: { question: "¿Cuánto es?", options: [] },
            },
      ]);
    }
    if (text.includes("NO pudo leer bien")) {
      const said = /Mensaje del usuario: "(?:gasto )?([\d.]+) bs/i.exec(text);
      return reply([
        said
          ? {
              id: "u1",
              name: "draft_expense",
              input: {
                amount: said[1],
                currency: "VES",
                description: "Factura",
                category_name: "",
                when: "",
                rate: "",
                corrects_draft: false,
              },
            }
          : {
              id: "u2",
              name: "ask_clarification",
              input: { question: "¿Cuánto fue y en qué moneda?", options: [] },
            },
      ]);
    }
    const m = /total ([\d.]+) (USD|VES)/.exec(text);
    const vendor = text.includes("cepillos y pala")
      ? "Cepillos y pala"
      : (/proveedor ([^;.]+)/.exec(text)?.[1] ?? "Factura");
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
        // Todos los casos usan el mismo teléfono y el mismo reloj: sin esto topan el límite.
        knownMax: 1000,
        captionWaitMs: 30,
      },
    };
  }

  async function sendImage(client: MetaClient, vision: ReceiptReader | null, noCaption = false) {
    jobs.length = 0;
    const p = JSON.parse(JSON.stringify(fx.imageMessage));
    p.entry[0].changes[0].value.messages[0].id = `wamid.IMG${++seq}`;
    if (noCaption) delete p.entry[0].changes[0].value.messages[0].image.caption;
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

  it("no es factura o lector caído: respuestas sin respaldo", async () => {
    const notReceipt = fakeMeta();
    await sendImage(notReceipt.client, fakeVision({ ...RECEIPT, is_receipt: false }));
    expect(textOf(notReceipt.sent[1])).toContain("Solo proceso facturas y recibos");
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
  it("factura ilegible: un solo mensaje pide todo, guarda la foto y la respuesta siguiente es el borrador", async () => {
    const { sent, client } = fakeMeta();
    const vision = fakeVision({
      ...RECEIPT,
      total: "12955.10",
      currency: "VES",
      vendor: "",
      confidence: 0.3,
    });
    const before = store.objects.size;
    await sendImage(client, vision);
    const ask = textOf(sent[1]);
    expect(ask).toContain("No pude leer bien la factura");
    expect(ask).toContain("Me pareció ver un total de *Bs 12.955,10*");
    expect(ask).toContain("*un solo mensaje*");
    expect(ask).toContain("y la guardo con la foto");
    expect(ask).toContain("Ejemplo: _gasto 12.955 Bs en comida_");
    expect(store.objects.size).toBe(before + 1);
    const att = (await attachments()).at(-1);

    jobs.length = 0;
    const p = fx.textMessage(`wamid.UNC${++seq}`, "12956 bs");
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    await processInbound(deps(client, vision), jobs[0] as ProcessMessageJob);
    const draft = textOf(sent[2]);
    expect(draft).toContain("Gasto por confirmar");
    expect(draft).toContain("Bs 12.956,00");
    await tap(client, vision, buttonsOf(sent[2])[0]?.id as string, "Guardar");
    const [mv] = await withTenant(t.db, tenantId, (tx) =>
      tx
        .select()
        .from(schema.movement)
        .where(eq(schema.movement.attachmentId, att?.id as string)),
    );
    expect(mv).toMatchObject({ amountVes: "12956.00", description: "Factura" });

    // Solo la respuesta inmediata hereda la foto: el mensaje siguiente ya no lleva el contexto.
    jobs.length = 0;
    const q = fx.textMessage(`wamid.UNC${++seq}`, "15 bs");
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, q);
    await processInbound(deps(client, vision), jobs[0] as ProcessMessageJob);
    expect(textOf(sent[sent.length - 1])).toBe("¿Cuánto fue?");
  });
  const PAGO_MOVIL: ReceiptExtraction = {
    is_receipt: false,
    total: "1250.00",
    currency: "VES",
    date: "",
    vendor: "",
    line_items_count: 0,
    confidence: 0.9,
    document_type: "pago_movil",
    payee: {
      bank: "Banco Venezuela",
      phone: "0412-302.02.56",
      id_number: "C.I 25.871.244",
      holder: "Javier Ortiz",
    },
  };

  it("pago móvil con monto: resumen, cada dato para copiar y el borrador de gasto con la foto", async () => {
    const { sent, client } = fakeMeta();
    const before = store.objects.size;
    await sendImage(client, fakeVision(PAGO_MOVIL), true);
    expect(store.objects.size).toBe(before + 1);
    expect(textOf(sent[1])).toBe(
      [
        "📲 *Pago móvil*",
        "Banco: 0102 · Banco de Venezuela",
        "Teléfono: 0412-3020256",
        "Cédula/RIF: V-25871244",
        "Titular: Javier Ortiz",
        "Monto: *Bs 1.250,00*",
        "",
        "Abajo va cada dato solo para copiarlo y pegarlo en el banco 👇",
      ].join("\n"),
    );
    expect(textOf(sent[2])).toBe("04123020256");
    expect(textOf(sent[3])).toBe("25871244");
    expect(textOf(sent[4])).toBe("1250,00");
    const draft = textOf(sent[5]);
    expect(draft.startsWith("💸 ¿Es un gasto? Si lo es, toca *Guardar*")).toBe(true);
    expect(draft).toContain("Pago móvil a Javier Ortiz");
    const att = (await attachments()).at(-1);
    await tap(client, fakeVision(PAGO_MOVIL), buttonsOf(sent[5])[0]?.id as string, "Guardar");
    const [mv] = await withTenant(t.db, tenantId, (tx) =>
      tx
        .select()
        .from(schema.movement)
        .where(eq(schema.movement.attachmentId, att?.id as string)),
    );
    expect(mv).toMatchObject({ amountVes: "1250.00", description: "Pago móvil a Javier Ortiz" });
  });

  it("pago móvil en dólares: el monto a pegar sale en bolívares a tasa BCV", async () => {
    const { sent, client } = fakeMeta();
    await sendImage(client, fakeVision({ ...PAGO_MOVIL, total: "10", currency: "USD" }), true);
    expect(textOf(sent[1])).toContain("Monto: *Bs 8.580,00* ($10,00 a tasa BCV 858,00)");
    expect(textOf(sent[4])).toBe("8580,00");
    // Deja la cola limpia para los casos siguientes.
    await tap(client, null, buttonsOf(sent[5])[2]?.id as string, "Cancelar");
  });

  it("pago móvil sin monto: pregunta, y la respuesta arma el gasto con la foto", async () => {
    const { sent, client } = fakeMeta();
    await sendImage(client, fakeVision({ ...PAGO_MOVIL, total: "" }), true);
    expect(sent).toHaveLength(5);
    expect(textOf(sent[3])).toBe("25871244");
    expect(textOf(sent[4])).toContain("Escríbeme el *monto* y *en qué es*");
    const att = (await attachments()).at(-1);
    jobs.length = 0;
    const p = fx.textMessage(`wamid.PM${++seq}`, "1250 bs del gas");
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    await processInbound(deps(client, null), jobs[0] as ProcessMessageJob);
    expect(textOf(sent[5])).toContain("Gasto por confirmar");
    await tap(client, null, buttonsOf(sent[5])[0]?.id as string, "Guardar");
    const [mv] = await withTenant(t.db, tenantId, (tx) =>
      tx
        .select()
        .from(schema.movement)
        .where(eq(schema.movement.attachmentId, att?.id as string)),
    );
    expect(mv).toMatchObject({ amountVes: "1250.00", description: "gas" });
  });

  it("pago móvil ilegible: lo dice y no arma nada", async () => {
    const { sent, client } = fakeMeta();
    await sendImage(
      client,
      fakeVision({ ...PAGO_MOVIL, payee: { bank: "", phone: "04", id_number: "", holder: "" } }),
    );
    expect(sent).toHaveLength(2);
    expect(textOf(sent[1])).toContain("no pude leer bien el teléfono ni la cédula");
  });
  async function ingestOnly(p: unknown): Promise<ProcessMessageJob> {
    jobs.length = 0;
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    return jobs[0] as ProcessMessageJob;
  }
  const photoPayload = () => {
    const p = JSON.parse(JSON.stringify(fx.imageMessage));
    p.entry[0].changes[0].value.messages[0].id = `wamid.CAP${++seq}`;
    delete p.entry[0].changes[0].value.messages[0].image.caption;
    return p;
  };
  const pendingDrafts = () =>
    withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.pendingAction).where(eq(schema.pendingAction.status, "pending")),
    );
  async function cancelAll(client: MetaClient, sent: Sent[]) {
    for (const s of [...sent]) {
      const cancel = buttonsOf(s).find((b) => b.title === "Cancelar");
      if (cancel) await tap(client, null, cancel.id, "Cancelar");
    }
  }

  it("reenvío: el texto llega antes que la foto, no se contesta y queda como leyenda", async () => {
    const { sent, client } = fakeMeta();
    const vision = fakeVision(RECEIPT);
    const textJob = await ingestOnly(
      fx.textMessage(`wamid.CAP${++seq}`, "Registrar compra de cepillos y pala"),
    );
    // La foto entra mientras el texto espera (la cola por teléfono la deja detrás).
    const photoJob = await ingestOnly(photoPayload());
    await processInbound(deps(client, vision), textJob);
    expect(sent).toHaveLength(0);
    await processInbound(deps(client, vision), photoJob);
    expect(sent[0]?.body.reaction).toMatchObject({ emoji: "🧾" });
    expect(sent).toHaveLength(2);
    expect(textOf(sent[1])).toContain("Cepillos y pala: *$45,00*");
    await cancelAll(client, sent);
  });

  it("la foto llega tarde: el texto recibe su pregunta y la foto igual toma la leyenda", async () => {
    const { sent, client } = fakeMeta();
    const vision = fakeVision(RECEIPT);
    const textJob = await ingestOnly(
      fx.textMessage(`wamid.CAP${++seq}`, "Registrar compra de cepillos y pala"),
    );
    await processInbound(deps(client, vision), textJob);
    expect(textOf(sent[0])).toBe("¿Cuánto fue?");
    await processInbound(deps(client, vision), await ingestOnly(photoPayload()));
    expect(textOf(sent[2])).toContain("Cepillos y pala: *$45,00*");
    await cancelAll(client, sent);
  });

  it("un texto con monto no espera ni se usa como leyenda", async () => {
    const { sent, client } = fakeMeta();
    const vision = fakeVision(RECEIPT);
    const textJob = await ingestOnly(fx.textMessage(`wamid.CAP${++seq}`, "15 de cepillos y pala"));
    const photoJob = await ingestOnly(photoPayload());
    await processInbound(deps(client, vision), textJob);
    expect(sent).toHaveLength(1);
    await processInbound(deps(client, vision), photoJob);
    expect(textOf(sent[2])).toContain("Ferretería El Tornillo");
    await cancelAll(client, sent);
  });

  it("foto primero y el texto después: el texto describe el borrador de la foto", async () => {
    const { sent, client } = fakeMeta();
    const vision = fakeVision(RECEIPT);
    await processInbound(deps(client, vision), await ingestOnly(photoPayload()));
    expect(textOf(sent[1])).toContain("Ferretería El Tornillo");
    const att = (await attachments()).at(-1);
    await processInbound(
      deps(client, vision),
      await ingestOnly(fx.textMessage(`wamid.CAP${++seq}`, "Registrar compra de cepillos y pala")),
    );
    expect(textOf(sent[2])).toContain("Cepillos y pala: *$45,00*");
    const drafts = await pendingDrafts();
    expect(drafts).toHaveLength(1);
    expect((drafts[0]?.payload as { attachmentId?: string } | undefined)?.attachmentId).toBe(
      att?.id,
    );
    await cancelAll(client, sent);
  });
});
