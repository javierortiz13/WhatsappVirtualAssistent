import { eq, schema } from "@caja/db";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BATCH_KEY,
  BatchRefused,
  planSignupBatch,
  qualityStop,
  runSignupBatch,
} from "../src/onboarding/signup-batch";
import { saveSignupRescueSettings } from "../src/onboarding/signup-rescue";
import { MetaClient } from "../src/whatsapp/client";

/** (B) el lote único de la plantilla del registro (US-SR-08). */
const H = 3_600_000;
/** Martes 10/11/2026, 10:05 de Caracas. */
const START = new Date("2026-11-10T14:05:00Z");
const TEMPLATE = { name: "rocco_registro_pendiente", language: "es", wabaId: null };

type Reply = { error?: number; held?: boolean };

function fakeMeta(script: (i: number) => Reply = () => ({})) {
  const sent: { to: string; template: unknown }[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!init?.method || init.method === "GET")
      return new Response(JSON.stringify({ error: { message: "sin permiso", code: 10 } }), {
        status: 403,
      });
    const body = JSON.parse(String(init.body)) as { to: string; template: unknown };
    const r = script(i++);
    if (r.error)
      return new Response(JSON.stringify({ error: { message: "x", code: r.error } }), {
        status: 400,
      });
    sent.push({ to: body.to, template: body.template });
    void url;
    return new Response(
      JSON.stringify({
        messages: [
          {
            id: `wamid.B${sent.length}`,
            message_status: r.held ? "held_for_quality_assessment" : "accepted",
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { sent, client: new MetaClient({ accessToken: "T", phoneNumberId: "P", fetchImpl }) };
}

describe("lote único de la plantilla del registro", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let clock = START;
  const run = (meta: MetaClient, over: Partial<Parameters<typeof runSignupBatch>[2]> = {}) =>
    runSignupBatch(t.db, meta, {
      template: TEMPLATE,
      confirm: null,
      now: () => clock,
      sleep: async (ms) => {
        clock = new Date(clock.getTime() + ms);
      },
      ...over,
    });
  /** `n` registros parados hace 2 días + i horas (el 0 es el más reciente). */
  const backlog = async (n: number) => {
    const rows = [];
    for (let i = 0; i < n; i++)
      rows.push({
        e164: `58426${String(i).padStart(7, "0")}`,
        step: i % 2 ? "categories" : "name",
        data: {},
        messages: 2,
        updatedAt: new Date(START.getTime() - 48 * H - i * H),
      });
    await t.db.insert(schema.signup).values(rows);
  };

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    clock = START;
    await t.db.delete(schema.signup);
    await t.db.delete(schema.appSetting).where(eq(schema.appSetting.key, BATCH_KEY));
    await saveSignupRescueSettings(t.db, { template: true, holdoutPct: 20 }, "test", START);
  });

  it("solo cuenta: excluidos por motivo, elegibles por paso, el más reciente primero; nada impreso con números", async () => {
    await backlog(3);
    const now = START;
    await t.db.insert(schema.signup).values([
      { e164: "584260000101", step: "name", data: {}, updatedAt: new Date(now.getTime() - H) },
      {
        e164: "584260000102",
        step: "name",
        data: {},
        updatedAt: new Date(now.getTime() - 40 * 24 * H),
      },
      {
        e164: "584260000103",
        step: "name",
        data: {},
        updatedAt: new Date(now.getTime() - 48 * H),
        contactOffAt: now,
      },
      {
        e164: "584260000104",
        step: "name",
        data: {},
        updatedAt: new Date(now.getTime() - 48 * H),
        founderContactedAt: now,
      },
      {
        e164: "584260000105",
        step: "name",
        data: {},
        updatedAt: new Date(now.getTime() - 48 * H),
        rescueVia: "holdout",
      },
      { e164: "584260000106", step: "name", data: {}, updatedAt: new Date(now.getTime() - 48 * H) },
    ]);
    const plan = await planSignupBatch(t.db, { now, parkNumbers: ["+58 426-000-0106"] });
    expect(plan.excluded).toMatchObject({
      window_open: 1,
      too_old: 1,
      contact_off: 1,
      founder: 1,
      holdout: 1,
      internal: 1,
    });
    expect(plan.eligibleByStep).toEqual({ name: 2, categories: 1 });
    expect(plan.toSend).toBe(3);
    expect(plan.rows[0]?.e164).toBe("584260000000");
    const { rows, ...printed } = plan;
    expect(JSON.stringify(printed)).not.toMatch(/58426/);
    expect(rows).toHaveLength(3);
  });

  it("se niega sin --confirm, fuera de mar–jue 10:00–10:45, con --interval-s 30 y con el interruptor apagado", async () => {
    await backlog(2);
    const m = fakeMeta();
    await expect(run(m.client)).rejects.toBeInstanceOf(BatchRefused);
    await expect(run(m.client, { confirm: 3 })).rejects.toThrow("--confirm tiene que ser 2");
    clock = new Date("2026-11-14T14:05:00Z"); // sábado
    await expect(run(m.client, { confirm: 2 })).rejects.toThrow("martes a jueves");
    clock = new Date("2026-11-10T15:00:00Z"); // martes 11:00
    await expect(run(m.client, { confirm: 2 })).rejects.toThrow("martes a jueves");
    clock = START;
    await expect(run(m.client, { confirm: 2, intervalS: 30 })).rejects.toThrow("--interval-s");
    // CC-2 y CC-3: no numéricos y fuera de 1–30 se niegan.
    await expect(run(m.client, { confirm: 2, intervalS: Number("abc") })).rejects.toThrow(
      "--interval-s",
    );
    await expect(run(m.client, { confirm: 2, maxAgeDays: 90 })).rejects.toThrow("1 a 30");
    await expect(run(m.client, { confirm: 2, maxAgeDays: Number("abc") })).rejects.toThrow(
      "1 a 30",
    );
    await expect(planSignupBatch(t.db, { now: START, maxAgeDays: 90 })).rejects.toThrow("1 a 30");
    await expect(run(m.client, { confirm: 2, includeHoldout: true })).rejects.toThrow("holdout");
    await saveSignupRescueSettings(t.db, { template: false }, "test", START);
    await expect(run(m.client, { confirm: 2 })).rejects.toThrow("apagado");
    expect(m.sent).toHaveLength(0);
  });

  it("31 elegibles → 30 enviados, el más reciente primero, uno cada 90 s; un segundo --apply se niega", async () => {
    await backlog(31);
    const m = fakeMeta();
    const r = await run(m.client, { confirm: 30 });
    expect(r).toMatchObject({ sent: 30, stop: null, unsent: 0, costUsd: 2.22 });
    expect(m.sent[0]?.to).toBe("584260000000");
    expect(m.sent[29]?.to).toBe("584260000029");
    expect(clock.getTime() - START.getTime()).toBe(29 * 90_000);
    expect(m.sent[0]?.template).toMatchObject({ name: "rocco_registro_pendiente" });
    const marked = await t.db
      .select()
      .from(schema.signup)
      .where(eq(schema.signup.rescueVia, "template"));
    expect(marked).toHaveLength(30);
    clock = START;
    await expect(run(fakeMeta().client, { confirm: 1 })).rejects.toThrow();
    const again = await planSignupBatch(t.db, { now: START });
    expect(again.toSend).toBe(1);
    await expect(run(fakeMeta().client, { confirm: 1 })).rejects.toThrow("no hay segunda");
  });

  it("S2: dos «No me escribas» durante la corrida la paran antes del siguiente envío", async () => {
    await backlog(5);
    const m = fakeMeta();
    let sleeps = 0;
    const r = await run(m.client, {
      confirm: 5,
      sleep: async (ms) => {
        clock = new Date(clock.getTime() + ms);
        if (++sleeps === 2)
          await t.db
            .update(schema.signup)
            .set({ contactOffAt: clock })
            .where(eq(schema.signup.rescueVia, "template"));
      },
    });
    expect(r).toMatchObject({ stop: "S2", sent: 2, optOuts: 2, unsent: 3 });
    expect(m.sent).toHaveLength(2);
  });

  it("S3: un 132015 la para; S5 no cuenta el 131049; la salida no lleva números", async () => {
    await backlog(4);
    const m = fakeMeta((i) => (i === 0 ? { error: 132015 } : {}));
    const printed: string[] = [];
    const r = await run(m.client, { confirm: 4, log: (l) => printed.push(l) });
    expect(printed.join("\n")).not.toMatch(/58426|\*\*\*\*/);
    expect(printed.join("\n")).toContain("envío fallido (código 132015)");
    expect(r).toMatchObject({ stop: "S3", failedByCode: { "132015": 1 }, unsent: 3 });
    await t.db.delete(schema.signup);
    await t.db.delete(schema.appSetting).where(eq(schema.appSetting.key, BATCH_KEY));
    clock = START;
    await backlog(3);
    const m2 = fakeMeta((i) => (i < 2 ? { error: 131049 } : {}));
    const r2 = await run(m2.client, { confirm: 3 });
    expect(r2).toMatchObject({ stop: null, sent: 1, failedByCode: { "131049": 2 } });
  });

  it("S4: una respuesta held_for_quality_assessment la para", async () => {
    await backlog(3);
    const r = await run(fakeMeta((i) => ({ held: i === 0 })).client, { confirm: 3 });
    expect(r).toMatchObject({ stop: "S4", held: 1, sent: 0, unsent: 2 });
  });

  it("S5: dos fallos de otro código la paran", async () => {
    await backlog(4);
    const r = await run(fakeMeta((i) => (i < 2 ? { error: 131026 } : {})).client, { confirm: 4 });
    expect(r).toMatchObject({ stop: "S5", unsent: 2 });
  });

  it("S3 por webhook: un estado failed guardado con un código de parada", async () => {
    await backlog(3);
    const r = await run(fakeMeta().client, {
      confirm: 3,
      sleep: async (ms) => {
        clock = new Date(clock.getTime() + ms);
        await t.db
          .insert(schema.webhookEvent)
          .values({
            eventKey: "status:wamid.B1:failed",
            payload: { errors: [{ code: 131048 }] },
            status: "ignored",
          })
          .onConflictDoNothing();
      },
    });
    expect(r).toMatchObject({ stop: "S3", sent: 1 });
    await t.db.delete(schema.webhookEvent);
  });

  it("S1: apagar el interruptor a mitad la para; S7: pasan las 11:30", async () => {
    await backlog(3);
    const r = await run(fakeMeta().client, {
      confirm: 3,
      sleep: async (ms) => {
        clock = new Date(clock.getTime() + ms);
        await saveSignupRescueSettings(t.db, { template: false }, "test", clock);
      },
    });
    expect(r).toMatchObject({ stop: "S1", sent: 1 });
    await t.db.delete(schema.signup);
    await t.db.delete(schema.appSetting).where(eq(schema.appSetting.key, BATCH_KEY));
    await saveSignupRescueSettings(t.db, { template: true }, "test", START);
    clock = new Date("2026-11-10T14:44:00Z"); // 10:44
    await backlog(3);
    const late = await run(fakeMeta().client, { confirm: 3, intervalS: 3600 });
    expect(late).toMatchObject({ stop: "S7", sent: 1 });
  });

  it("CC-4: una plantilla que no es MARKETING para la corrida (S6)", () => {
    const q = {
      templateStatus: "APPROVED",
      templateCategory: "UTILITY",
      templateQuality: "GREEN",
      phoneQuality: "GREEN",
      messagingLimit: null,
    };
    expect(qualityStop(q)).toBe(true);
    expect(qualityStop({ ...q, templateCategory: "MARKETING" })).toBe(false);
    expect(qualityStop({ ...q, templateCategory: null })).toBe(false);
  });
});
