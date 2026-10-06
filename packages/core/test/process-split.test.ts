import { eq, schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stubAgent } from "../src/agent/stub";
import { Decimal } from "../src/domain/money";
import type { Bill, SplitAssignment } from "../src/domain/split";
import { ingestWebhook } from "../src/inbox/ingest";
import { type ProcessDeps, processInbound } from "../src/inbox/process";
import type { BillReader } from "../src/vision/bill";
import type { ReceiptReader } from "../src/vision/receipt";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/** Dividir la cuenta por WhatsApp (06/10): foto con "dividir", quién consumió qué y guardar mi parte. */
type Sent = { body: Record<string, unknown> };

const BILL: Bill = {
  vendor: "Pizzería Napoli",
  currency: "USD",
  items: [
    { name: "Pizza margarita", quantity: 1, amount: new Decimal("12.00") },
    { name: "Hamburguesa", quantity: 1, amount: new Decimal("9.00") },
    { name: "Refresco", quantity: 2, amount: new Decimal("4.00") },
  ],
  total: new Decimal("27.50"),
};

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Reparte según lo que diga el texto: "yo … Pedro …" o "entre 3". */
function fakeBills(): BillReader & { assigned: string[] } {
  return {
    assigned: [],
    async readBill() {
      return { bill: BILL, confidence: 0.9, usage, costUsd: "0.003000" };
    },
    async assign(_bill, text) {
      this.assigned.push(text);
      let assignment: SplitAssignment | null = null;
      if (/entre 3/.test(text)) assignment = { people: [], sharedByAll: [], equalSplit: 3 };
      else if (/pedro/i.test(text))
        assignment = {
          people: [
            {
              name: "Tú",
              isMe: true,
              items: [
                { index: 1, units: 0 },
                { index: 3, units: 0 },
              ],
            },
            {
              name: "Pedro",
              isMe: false,
              items: [
                { index: 2, units: 0 },
                ...(/compart/i.test(text) ? [{ index: 3, units: 0 }] : []),
              ],
            },
          ],
          sharedByAll: [],
          equalSplit: 0,
        };
      return { assignment, usage, costUsd: "0.001000" };
    },
  };
}

const vision: ReceiptReader = {
  provider: "fake",
  async read() {
    throw new Error("no debe leerse como factura");
  },
};

describe("dividir la cuenta por WhatsApp", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  const sent: Sent[] = [];
  const jobs: ProcessMessageJob[] = [];
  const bills = fakeBills();
  let n = 0;
  const now = () => new Date();

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/MEDIA_IMG"))
      return Response.json({
        id: "MEDIA_IMG",
        url: "https://lookaside.test/img/1",
        mime_type: "image/jpeg",
      });
    if (u.startsWith("https://lookaside.test/"))
      return new Response(new Uint8Array(2000), {
        status: 200,
        headers: { "content-type": "image/jpeg", "content-length": "2000" },
      });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (body.status !== "read") sent.push({ body });
    return Response.json({ messages: [{ id: `wamid.OUT.${++n}` }] });
  }) as typeof fetch;
  const meta = new MetaClient({ accessToken: "T", phoneNumberId: fx.PHONE_NUMBER_ID, fetchImpl });
  const deps = (): ProcessDeps => ({
    db: t.db,
    metaFor: () => meta,
    agent: stubAgent,
    vision,
    bills,
    now,
    config: {
      assistantName: "Asistente de Caja",
      dashboardUrl: "https://caja.test",
      supportHint: null,
      unknownReplyMax: 5,
      unknownReplyWindowMs: 3_600_000,
      maxEventAgeMs: 12 * 3_600_000,
      maxTextLength: 500,
    },
  });

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Javier",
      businessType: "personal",
      ownerPhone: "584121234567",
    });
    const today = new Date().toISOString().slice(0, 10);
    await t.db
      .insert(schema.bcvRate)
      .values({ effectiveDate: today, rate: "872.39000000", source: "test" });
  });
  afterAll(() => t.close());

  async function send(payload: unknown) {
    jobs.length = 0;
    await ingestWebhook(
      { db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) },
      payload,
    );
    const job = jobs[0];
    if (!job) throw new Error("no se encoló nada");
    return processInbound(deps(), job);
  }
  function photo(caption: string) {
    const p = structuredClone(fx.imageMessage) as unknown as {
      entry: { changes: { value: { messages: { id: string; image: { caption: string } }[] } }[] }[];
    };
    const m = p.entry[0]?.changes[0]?.value.messages[0];
    if (m) {
      m.id = `wamid.IMG.${++n}`;
      m.image.caption = caption;
    }
    return p;
  }
  const text = (body: string) => fx.textMessage(`wamid.T.${++n}`, body);
  function button(id: string, title: string) {
    const p = structuredClone(fx.buttonReply) as unknown as {
      entry: {
        changes: {
          value: { messages: { id: string; interactive: { button_reply: unknown } }[] };
        }[];
      }[];
    };
    const m = p.entry[0]?.changes[0]?.value.messages[0];
    if (m) {
      m.id = `wamid.BTN.${++n}`;
      m.interactive.button_reply = { id, title };
    }
    return p;
  }
  const last = () => sent.at(-1)?.body;
  const lastText = () =>
    String(
      (last()?.text as { body?: string } | undefined)?.body ??
        (last()?.interactive as { body?: { text?: string } } | undefined)?.body?.text ??
        "",
    );
  const lastButtons = () =>
    (
      (last()?.interactive as { action?: { buttons?: { reply: { id: string; title: string } }[] } })
        ?.action?.buttons ?? []
    ).map((b) => b.reply);

  it("foto con 'dividir' sin decir quién: la lista numerada y la pregunta; no es un gasto", async () => {
    expect(await send(photo("dividir la cuenta"))).toBe("done");
    expect(lastText()).toContain("1. Pizza margarita — $12,00");
    expect(lastText()).toContain("3. Refresco ×2 — $4,00");
    expect(lastText()).toContain("¿Quién consumió qué?");
    expect(
      await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.pendingAction)),
    ).toEqual([]);
  });

  it("la respuesta reparte, con el servicio proporcional, y ofrece guardar mi parte", async () => {
    await send(text("yo la pizza y los refrescos, Pedro la hamburguesa"));
    const body = lastText();
    // 25 de renglones, 27,50 de total: 10 % repartido. Tú 16 → 17,60; Pedro 9 → 9,90.
    expect(body).toContain("👤 *Tú: $17,60*");
    expect(body).toContain("👤 *Pedro: $9,90*");
    expect(body).toContain("IVA, servicio o propina ($2,50)");
    expect(body).toContain("¿Guardo tu parte (*$17,60*) como gasto?");
    expect(lastButtons().map((b) => b.title)).toEqual(["Guardar mi parte", "No, gracias"]);
  });

  it("una corrección reparte de nuevo y reemplaza el borrador anterior", async () => {
    await send(text("no, el refresco lo compartimos con Pedro"));
    expect(bills.assigned.at(-1)).toContain("yo la pizza y los refrescos");
    expect(lastText()).toContain("👤 *Tú: $15,40*");
    expect(lastText()).toContain("Refresco (compartido)");
    const pending = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.pendingAction).where(eq(schema.pendingAction.status, "pending")),
    );
    expect(pending).toHaveLength(1);
  });

  it("Guardar mi parte registra el gasto", async () => {
    const save = lastButtons()[0];
    await send(button(save?.id ?? "", save?.title ?? ""));
    const [m] = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.movement));
    expect(m?.amount).toBe("15.40");
    expect(m?.description).toBe("Mi parte · Pizzería Napoli");
  });

  it("foto con 'entre 3' en la leyenda: partes iguales de una vez", async () => {
    await send(photo("dividir entre 3"));
    expect(lastText()).toContain("👥 Entre 3: *$9,17* cada uno");
  });
});
