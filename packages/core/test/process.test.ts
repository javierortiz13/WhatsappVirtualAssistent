import { schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stubAgent } from "../src/agent/stub.js";
import { ingestWebhook } from "../src/inbox/ingest.js";
import { classifyKeyword, type ProcessDeps, processInbound } from "../src/inbox/process.js";
import { MetaClient } from "../src/whatsapp/client.js";
import * as fx from "./fixtures.js";

type Sent = { url: string; body: Record<string, unknown> };

const textOf = (s: Sent | undefined): string =>
  String((s?.body.text as { body?: string } | undefined)?.body ?? "");

function fakeMeta(
  behaviour: () => { status: number; body: unknown } = () => ({
    status: 200,
    body: { messages: [{ id: `wamid.OUT.${Math.random()}` }] },
  }),
) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (body.status === "read") {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    sent.push({ url: String(url), body });
    const r = behaviour();
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    sent,
    client: new MetaClient({ accessToken: "T", phoneNumberId: fx.PHONE_NUMBER_ID, fetchImpl }),
  };
}

describe("processInbound", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  const now = () => new Date("2026-09-29T15:00:00Z");
  const jobs: ProcessMessageJob[] = [];

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Autolavado El Rápido",
      businessType: "car_wash",
      ownerPhone: "584121234567",
    });
    await withTenant(t.db, tenantId, (tx) =>
      tx.insert(schema.phoneNumber).values({
        tenantId,
        e164: "584140000002",
        role: "employee",
        status: "active",
        displayName: "Carlos",
      }),
    );
    await t.db.insert(schema.bcvRate).values([
      { effectiveDate: "2026-09-29", rate: "858.00000000", source: "test" },
      { effectiveDate: "2026-09-30", rate: "859.30000000", source: "test" },
    ]);
  });
  afterAll(() => t.close());

  function deps(meta: MetaClient): ProcessDeps {
    return {
      db: t.db,
      metaFor: (id) => (id === fx.PHONE_NUMBER_ID ? meta : null),
      agent: stubAgent,
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
    };
  }

  /** Ingesta real (webhook_event + job capturado) y luego procesamiento. */
  async function ingest(payload: unknown): Promise<ProcessMessageJob> {
    jobs.length = 0;
    await ingestWebhook(
      { db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) },
      payload,
    );
    const job = jobs[0];
    if (!job) throw new Error("no se encoló nada");
    return job;
  }

  function message(id: string, from: string, body: string) {
    const p = fx.textMessage(id, body) as unknown as {
      entry: {
        changes: { value: { messages: { from: string }[]; contacts: { wa_id: string }[] } }[];
      }[];
    };
    const v = p.entry[0]?.changes[0]?.value;
    if (v?.messages[0]) v.messages[0].from = from;
    if (v?.contacts[0]) v.contacts[0].wa_id = from;
    return p;
  }

  it("número desconocido: texto fijo con enlace de registro, sin guardar mensaje, evento ignorado", async () => {
    const { sent, client } = fakeMeta();
    const job = await ingest(message("wamid.U1", "580000000009", "hola"));
    expect(await processInbound(deps(client), job)).toBe("ignored");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({ to: "580000000009", type: "text" });
    expect(textOf(sent[0])).toContain("https://caja.test/registro");
    const msgs = await t.db.select().from(schema.message);
    expect(msgs).toHaveLength(0);
  });

  it("'hola' responde el menú con la tasa y 3 botones, y registra entrada y salida", async () => {
    const { sent, client } = fakeMeta();
    const job = await ingest(message("wamid.H1", "584121234567", "Hola!"));
    expect(await processInbound(deps(client), job)).toBe("done");
    expect(sent).toHaveLength(1);
    const body = sent[0]?.body as {
      type: string;
      interactive: { body: { text: string }; action: { buttons: unknown[] } };
    };
    expect(body.type).toBe("interactive");
    expect(body.interactive.body.text).toContain("Bs 858,00");
    expect(body.interactive.action.buttons).toHaveLength(3);
    const rows = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.message));
    const inbound = rows.find((r) => r.waMessageId === "wamid.H1");
    expect(inbound?.direction).toBe("in");
    const outbound = rows.find(
      (r) => r.direction === "out" && r.webhookEventId === job.webhookEventId,
    );
    expect(outbound?.status).toBe("ok");
    expect(outbound?.latencyMs).toBeTypeOf("number");
  });

  it("'tasa' y 'ayuda' se resuelven sin agente", async () => {
    const { sent, client } = fakeMeta();
    await processInbound(deps(client), await ingest(message("wamid.T1", "584121234567", "tasa")));
    expect(textOf(sent[0])).toContain("Próxima (mié 30/09): *Bs 859,30*");
    await processInbound(deps(client), await ingest(message("wamid.A1", "584121234567", "ayuda")));
    expect(textOf(sent[1])).toContain("https://caja.test");
  });

  it("texto libre va al agente (stub: fuera de alcance con menú)", async () => {
    const { sent, client } = fakeMeta();
    await processInbound(
      deps(client),
      await ingest(message("wamid.F1", "584121234567", "gasté 15$ en champú")),
    );
    const body = sent[0]?.body as { interactive: { body: { text: string } } };
    expect(body.interactive.body.text).toContain("Solo te ayudo con tu caja");
  });

  it("nota de voz y sticker reciben respuestas fijas por ahora", async () => {
    const { sent, client } = fakeMeta();
    await processInbound(deps(client), await ingest(fx.audioMessage));
    await processInbound(deps(client), await ingest(fx.stickerMessage));
    expect(textOf(sent[0])).toContain("notas de voz");
    expect(textOf(sent[1])).toContain("Solo entiendo");
  });

  it("botón Guardar sin borrador vigente: 'ya venció'; Cancelar con borrador: lo cancela", async () => {
    const { sent, client } = fakeMeta();
    await processInbound(deps(client), await ingest(fx.buttonReply));
    expect(textOf(sent[0])).toContain("ya venció");
    const [phone] = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.phoneNumber));
    const [pa] = await withTenant(t.db, tenantId, (tx) =>
      tx
        .insert(schema.pendingAction)
        .values({
          tenantId,
          phoneId: phone?.id ?? "",
          kind: "create_expense",
          payload: {},
          expiresAt: new Date("2026-09-29T15:10:00Z"),
        })
        .returning(),
    );
    const cancel = JSON.parse(JSON.stringify(fx.buttonReply));
    cancel.entry[0].changes[0].value.messages[0].id = "wamid.C1";
    cancel.entry[0].changes[0].value.messages[0].interactive.button_reply = {
      id: `cancel:${pa?.id}`,
      title: "Cancelar",
    };
    await processInbound(deps(client), await ingest(cancel));
    expect(textOf(sent[1])).toContain("descartado");
    const [after] = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.pendingAction),
    );
    expect(after?.status).toBe("cancelled");
  });

  it("empleado que toca 'Ver cierre' recibe 'solo el dueño'", async () => {
    const { sent, client } = fakeMeta();
    const p = JSON.parse(JSON.stringify(fx.buttonReply));
    p.entry[0].changes[0].value.messages[0].id = "wamid.E1";
    p.entry[0].changes[0].value.messages[0].from = "584140000002";
    p.entry[0].changes[0].value.contacts[0].wa_id = "584140000002";
    p.entry[0].changes[0].value.messages[0].interactive.button_reply = {
      id: "menu:close",
      title: "Ver cierre",
    };
    await processInbound(deps(client), await ingest(p));
    expect(textOf(sent[0])).toContain("El cierre lo ve el dueño");
  });

  it("reintento de un job ya respondido no reenvía", async () => {
    const { sent, client } = fakeMeta();
    const job = await ingest(message("wamid.D1", "584121234567", "hola"));
    expect(await processInbound(deps(client), job)).toBe("done");
    expect(await processInbound(deps(client), job)).toBe("duplicate");
    expect(sent).toHaveLength(1);
  });

  it("Meta 4xx: se marca failed y el job termina; Meta 5xx: lanza para reintentar y luego reenvía", async () => {
    const { client: c400 } = fakeMeta(() => ({
      status: 400,
      body: { error: { message: "bad", code: 131047 } },
    }));
    const job = await ingest(message("wamid.X1", "584121234567", "hola"));
    expect(await processInbound(deps(c400), job)).toBe("done");
    const rows = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.message));
    expect(
      rows.find((r) => r.webhookEventId === job.webhookEventId && r.direction === "out")?.status,
    ).toBe("failed");

    let calls = 0;
    const flaky = fakeMeta(() =>
      ++calls === 1
        ? { status: 503, body: { error: { message: "down" } } }
        : { status: 200, body: { messages: [{ id: "wamid.OK" }] } },
    );
    const job2 = await ingest(message("wamid.X2", "584121234567", "hola"));
    await expect(processInbound(deps(flaky.client), job2)).rejects.toMatchObject({
      retryable: true,
    });
    expect(await processInbound(deps(flaky.client), job2)).toBe("done");
    expect(flaky.sent).toHaveLength(2);
  });

  it("evento con más de 12 h se marca vencido sin responder", async () => {
    const { sent, client } = fakeMeta();
    const job = await ingest(message("wamid.OLD", "584121234567", "hola"));
    const old = { ...deps(client), now: () => new Date("2026-09-30T15:00:00Z") };
    expect(await processInbound(old, job)).toBe("expired");
    expect(sent).toHaveLength(0);
  });
});

describe("classifyKeyword", () => {
  it.each([
    ["Hola", "menu"],
    ["buenas tardes!", "menu"],
    ["MENÚ", "menu"],
    ["tasa", "rate"],
    ["¿a cómo está el dólar?", "rate"],
    ["ayuda", "help"],
    ["gasté 15$ en champú", null],
    ["hola, gasté 20", null],
  ])("%s → %s", (input, expected) => {
    expect(classifyKeyword(input)).toBe(expected);
  });
});
