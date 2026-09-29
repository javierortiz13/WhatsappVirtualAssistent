import { schema } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestWebhook } from "../src/inbox/ingest";
import * as fx from "./fixtures";

describe("ingestWebhook", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  const sent: { job: ProcessMessageJob; key: string }[] = [];
  let failEnqueue = false;

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.close();
  });

  const deps = () => ({
    db: t.db,
    enqueue: async (_tx: unknown, job: ProcessMessageJob, key: string) => {
      if (failEnqueue) throw new Error("cola caída");
      sent.push({ job, key });
    },
  });

  it("guarda el evento y encola con clave de serialización por teléfono", async () => {
    const r = await ingestWebhook(deps(), fx.textMessage("wamid.T1"));
    expect(r).toEqual({ accepted: 1, duplicates: 0, failedStatuses: 0, ignored: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.key).toBe("584121234567");
    expect(sent[0]?.job).toMatchObject({
      waMessageId: "wamid.T1",
      phoneNumberId: fx.PHONE_NUMBER_ID,
      senderE164: "584121234567",
    });
    const events = await t.db.select().from(schema.webhookEvent);
    expect(events.map((e) => e.eventKey)).toEqual(["msg:wamid.T1"]);
  });

  it("un reenvío de Meta con el mismo id no crea otro job", async () => {
    const r = await ingestWebhook(deps(), fx.textMessage("wamid.T1"));
    expect(r.duplicates).toBe(1);
    expect(r.accepted).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("si encolar falla, el evento tampoco queda guardado (misma transacción)", async () => {
    failEnqueue = true;
    await expect(ingestWebhook(deps(), fx.textMessage("wamid.T2"))).rejects.toThrow(/cola/);
    failEnqueue = false;
    const events = await t.db.select().from(schema.webhookEvent);
    expect(events.map((e) => e.eventKey)).not.toContain("msg:wamid.T2");
    // Al reintentar Meta, entra limpio.
    const r = await ingestWebhook(deps(), fx.textMessage("wamid.T2"));
    expect(r.accepted).toBe(1);
  });

  it("dos mensajes del mismo remitente comparten clave y conservan orden", async () => {
    sent.length = 0;
    await ingestWebhook(deps(), fx.twoMessages);
    expect(sent.map((s) => s.job.waMessageId)).toEqual(["wamid.A", "wamid.B"]);
    expect(new Set(sent.map((s) => s.key)).size).toBe(1);
  });

  it("estados entregados no generan nada; fallidos se guardan sin job", async () => {
    sent.length = 0;
    const d = await ingestWebhook(deps(), fx.deliveredStatus);
    expect(d).toEqual({ accepted: 0, duplicates: 0, failedStatuses: 0, ignored: 0 });
    const f = await ingestWebhook(deps(), fx.failedStatus);
    expect(f.failedStatuses).toBe(1);
    expect(sent).toHaveLength(0);
    const events = await t.db.select().from(schema.webhookEvent);
    expect(events.find((e) => e.eventKey === "status:wamid.OUT2:failed")?.status).toBe("ignored");
  });

  it("usuario sin número usa el BSUID como clave", async () => {
    sent.length = 0;
    await ingestWebhook(deps(), fx.bsuidMessage);
    expect(sent[0]?.key).toBe("BSUID_XYZ");
    expect(sent[0]?.job.senderE164).toBeNull();
  });

  it("otros campos del webhook se cuentan como ignorados", async () => {
    const r = await ingestWebhook(deps(), fx.otherField);
    expect(r.ignored).toBe(1);
  });
});
