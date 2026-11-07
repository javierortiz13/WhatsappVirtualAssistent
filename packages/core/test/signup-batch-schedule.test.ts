import { eq, schema } from "@caja/db";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { saveHabitSettings } from "../src/ledger/habits";
import { BATCH_KEY, BatchRefused } from "../src/onboarding/signup-batch";
import {
  batchSchedule,
  cancelSignupBatch,
  nextBatchSlot,
  runScheduledSignupBatch,
  SCHEDULE_KEY,
  SCHEDULE_REFUSALS,
  scheduleSignupBatch,
} from "../src/onboarding/signup-batch-schedule";
import { saveSignupRescueSettings, signupRescueSettings } from "../src/onboarding/signup-rescue";
import { MetaClient } from "../src/whatsapp/client";

/** El lote de la plantilla programado desde /admin (A-0031, decisión del fundador 05/11). */
const H = 3_600_000;
/** Lunes 09/11/2026, 21:00 de Caracas: el fundador lo programa. */
const MONDAY_NIGHT = new Date("2026-11-10T01:00:00Z");
/** Martes 10/11/2026, 10:00 de Caracas. */
const TUESDAY_10 = new Date("2026-11-10T14:00:00Z");
const TEMPLATE = { name: "rocco_registro_pendiente", language: "es", wabaId: "WABA" };

const denied = () =>
  new Response(JSON.stringify({ error: { message: "sin permiso", code: 10 } }), { status: 403 });

/**
 * Meta de prueba. La calidad se lee bien (APPROVED, MARKETING, GREEN) salvo que se diga otra
 * cosa: `phone` cambia la calidad del número y `unreadableAfter` hace que, después de ese número
 * de envíos, la calidad del número ya no se pueda leer.
 */
function fakeMeta(q: { phone?: string; unreadableAfter?: number } = {}) {
  const sent: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!init?.method || init.method === "GET") {
      const u = String(url);
      if (u.includes("/message_templates"))
        return new Response(
          JSON.stringify({
            data: [
              {
                name: TEMPLATE.name,
                status: "APPROVED",
                category: "MARKETING",
                quality_score: { score: "GREEN" },
              },
            ],
          }),
          { status: 200 },
        );
      if (u.includes("quality_rating")) {
        if (q.unreadableAfter !== undefined && sent.length >= q.unreadableAfter) return denied();
        return new Response(JSON.stringify({ quality_rating: q.phone ?? "GREEN" }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({ whatsapp_business_manager_messaging_limit: "TIER_1K" }),
        {
          status: 200,
        },
      );
    }
    const body = JSON.parse(String(init.body)) as { to: string };
    sent.push(body.to);
    return new Response(
      JSON.stringify({ messages: [{ id: `wamid.S${sent.length}`, message_status: "accepted" }] }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { sent, client: new MetaClient({ accessToken: "T", phoneNumberId: "P", fetchImpl }) };
}

describe("nextBatchSlot", () => {
  const at = (iso: string) => nextBatchSlot(new Date(iso)).toISOString();
  it("el próximo martes, miércoles o jueves a las 10:00 de Caracas", () => {
    // Jueves 05/11 16:50 → martes 10/11.
    expect(at("2026-11-05T20:50:00Z")).toBe("2026-11-10T14:00:00.000Z");
    // Martes 09:00 → ese mismo martes; martes 10:00 en punto → miércoles.
    expect(at("2026-11-10T13:00:00Z")).toBe("2026-11-10T14:00:00.000Z");
    expect(at("2026-11-10T14:00:00Z")).toBe("2026-11-11T14:00:00.000Z");
    // Jueves 11:00 → martes siguiente.
    expect(at("2026-11-12T15:00:00Z")).toBe("2026-11-17T14:00:00.000Z");
  });
});

describe("lote programado", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let clock = TUESDAY_10;
  const run = (meta: MetaClient, template: typeof TEMPLATE | { wabaId: null } = TEMPLATE) =>
    runScheduledSignupBatch(t.db, meta, {
      template: { ...TEMPLATE, ...template },
      now: () => clock,
      sleep: async (ms) => {
        clock = new Date(clock.getTime() + ms);
      },
    });
  /** `n` registros parados desde el domingo (el 0 es el más reciente). */
  const backlog = async (n: number, from = 0) => {
    const rows = [];
    for (let i = from; i < from + n; i++)
      rows.push({
        e164: `58426${String(i).padStart(7, "0")}`,
        step: "name",
        data: {},
        messages: 2,
        updatedAt: new Date(MONDAY_NIGHT.getTime() - 30 * H - i * H),
      });
    return t.db.insert(schema.signup).values(rows).returning({ id: schema.signup.id });
  };

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    clock = TUESDAY_10;
    await t.db.delete(schema.signup);
    await t.db.delete(schema.appSetting).where(eq(schema.appSetting.key, BATCH_KEY));
    await t.db.delete(schema.appSetting).where(eq(schema.appSetting.key, SCHEDULE_KEY));
    await saveSignupRescueSettings(
      t.db,
      { template: false, holdoutPct: 20, inWindowVia: "text" },
      "test",
      MONDAY_NIGHT,
    );
    await saveHabitSettings(t.db, { reminderTemplate: false }, "test", MONDAY_NIGHT);
  });

  /** El lote se negó antes de reclamar: nada salió y la corrida única sigue sin gastar. */
  const refusedBeforeClaim = async (meta: ReturnType<typeof fakeMeta>, reason: string) => {
    expect(meta.sent).toHaveLength(0);
    expect(await batchSchedule(t.db)).toMatchObject({ status: "refused", reason });
    const key = await t.db
      .select()
      .from(schema.appSetting)
      .where(eq(schema.appSetting.key, BATCH_KEY));
    expect(key).toHaveLength(0);
    expect((await signupRescueSettings(t.db)).template).toBe(false);
  };

  it("LB-1: sin la cuenta de WhatsApp (no se lee la plantilla) se niega antes de reclamar", async () => {
    await backlog(3);
    await scheduleSignupBatch(t.db, { actor: "fundador", now: MONDAY_NIGHT });
    const meta = fakeMeta();
    const r = await run(meta.client, { wabaId: null });
    expect(r).toMatchObject({ ran: true, result: null });
    await refusedBeforeClaim(meta, "S6: no se pudo leer la calidad del número o de la plantilla");
  });

  it("LB-1: con el número en amarillo se niega antes de reclamar", async () => {
    await backlog(3);
    await scheduleSignupBatch(t.db, { actor: "fundador", now: MONDAY_NIGHT });
    const meta = fakeMeta({ phone: "YELLOW" });
    await run(meta.client);
    await refusedBeforeClaim(meta, "S6: la calidad o la plantilla no están bien");
  });

  it("LB-1: si la calidad deja de leerse en el envío 6, para con S6", async () => {
    await backlog(8);
    await scheduleSignupBatch(t.db, { actor: "fundador", now: MONDAY_NIGHT });
    const meta = fakeMeta({ unreadableAfter: 5 });
    const r = await run(meta.client);
    expect(r.ran && r.result).toMatchObject({ sent: 5, stop: "S6", unsent: 3 });
    expect(meta.sent).toHaveLength(5);
    expect(await batchSchedule(t.db)).toMatchObject({
      status: "done",
      result: { sent: 5, stop: "S6", unsent: 3 },
    });
  });

  it("LB-3: con «recordatorio como plantilla» encendido se niega antes de reclamar", async () => {
    await backlog(2);
    await scheduleSignupBatch(t.db, { actor: "fundador", now: MONDAY_NIGHT });
    await saveSignupRescueSettings(t.db, { inWindowVia: "template" }, "fundador", MONDAY_NIGHT);
    const meta = fakeMeta();
    await run(meta.client);
    await refusedBeforeClaim(meta, "T4: «recordatorio como plantilla» está encendido");
  });

  it("LB-3: con los recordatorios por plantilla encendidos se niega antes de reclamar", async () => {
    await backlog(2);
    await scheduleSignupBatch(t.db, { actor: "fundador", now: MONDAY_NIGHT });
    await saveHabitSettings(t.db, { reminderTemplate: true }, "fundador", MONDAY_NIGHT);
    const meta = fakeMeta();
    await run(meta.client);
    await refusedBeforeClaim(meta, "T4: los recordatorios por plantilla están encendidos");
  });

  it("LB-2: se programa la noche antes, desde las 6 pm", async () => {
    await backlog(2);
    // Viernes 06/11 20:00 de Caracas: el martes queda a más de 16 h; no cambia nada.
    await expect(
      scheduleSignupBatch(t.db, { actor: "fundador", now: new Date("2026-11-07T00:00:00Z") }),
    ).rejects.toMatchObject({ reason: "prográmalo la noche antes, desde las 6 pm" });
    expect(await batchSchedule(t.db)).toBeNull();
    expect((await signupRescueSettings(t.db)).template).toBe(false);
    // Lunes 18:30 → martes 10:00.
    const s = await scheduleSignupBatch(t.db, {
      actor: "fundador",
      now: new Date("2026-11-09T22:30:00Z"),
    });
    expect(s.at).toBe(TUESDAY_10.toISOString());
    // Martes 09:00 → ese martes 10:00.
    await cancelSignupBatch(t.db, "fundador", new Date("2026-11-10T13:00:00Z"));
    const s2 = await scheduleSignupBatch(t.db, {
      actor: "fundador",
      now: new Date("2026-11-10T13:00:00Z"),
    });
    expect(s2.at).toBe(TUESDAY_10.toISOString());
  });

  it("LB-4: /admin solo muestra los motivos conocidos de programar", () => {
    expect(SCHEDULE_REFUSALS.has("prográmalo la noche antes, desde las 6 pm")).toBe(true);
    expect(SCHEDULE_REFUSALS.has("ya hay un lote programado")).toBe(true);
    expect(SCHEDULE_REFUSALS.has("<b>otra cosa</b>")).toBe(false);
  });

  it("LB-5: «corriendo» 2 h después de su hora queda «se cortó» y apaga el interruptor", async () => {
    await backlog(2);
    const s = await scheduleSignupBatch(t.db, { actor: "fundador", now: MONDAY_NIGHT });
    await t.db
      .update(schema.appSetting)
      .set({ value: { ...s, status: "running" } })
      .where(eq(schema.appSetting.key, SCHEDULE_KEY));
    const meta = fakeMeta();
    clock = new Date(TUESDAY_10.getTime() + 2 * H);
    expect(await run(meta.client)).toEqual({ ran: false, why: "none" });
    expect((await signupRescueSettings(t.db)).template).toBe(true);
    clock = new Date(TUESDAY_10.getTime() + 2 * H + 60_000);
    expect(await run(meta.client)).toEqual({ ran: false, why: "cut" });
    expect(await batchSchedule(t.db)).toMatchObject({ status: "done", reason: "se cortó" });
    expect((await signupRescueSettings(t.db)).template).toBe(false);
    expect(meta.sent).toHaveLength(0);
  });

  it("se programa el lunes en la noche y sale solo el martes a las 10:00; apaga el interruptor", async () => {
    await backlog(3);
    const s = await scheduleSignupBatch(t.db, { actor: "fundador", now: MONDAY_NIGHT });
    expect(s).toMatchObject({ status: "scheduled", confirm: 3, at: TUESDAY_10.toISOString() });
    expect((await signupRescueSettings(t.db)).template).toBe(true);
    const meta = fakeMeta();
    clock = new Date(TUESDAY_10.getTime() - 5 * 60_000);
    expect(await run(meta.client)).toEqual({ ran: false, why: "not_yet" });
    clock = TUESDAY_10;
    const r = await run(meta.client);
    expect(r.ran && r.result?.sent).toBe(3);
    expect(meta.sent).toHaveLength(3);
    const after = await batchSchedule(t.db);
    expect(after).toMatchObject({ status: "done", result: { sent: 3, failed: 0, stop: null } });
    expect((await signupRescueSettings(t.db)).template).toBe(false);
    // Ni otra vuelta ni otro programado.
    expect(await run(meta.client)).toEqual({ ran: false, why: "none" });
    await expect(
      scheduleSignupBatch(t.db, { actor: "fundador", now: TUESDAY_10 }),
    ).rejects.toBeInstanceOf(BatchRefused);
  });

  it("solo salen los confirmados que siguen elegibles: ni el que terminó ni uno nuevo", async () => {
    const [first] = await backlog(3);
    await scheduleSignupBatch(t.db, { actor: "fundador", now: MONDAY_NIGHT });
    // Uno terminó el registro en la noche; otro registro nuevo quedó parado después.
    await t.db
      .update(schema.signup)
      .set({ completedAt: MONDAY_NIGHT, step: "done" })
      .where(eq(schema.signup.id, first?.id ?? ""));
    await backlog(1, 10);
    const meta = fakeMeta();
    const r = await run(meta.client);
    expect(r.ran && r.result?.sent).toBe(2);
    expect(meta.sent).toHaveLength(2);
  });

  it("si el worker lo ve después de las 10:45, no corre (queda «no corrió») y apaga el interruptor", async () => {
    await backlog(2);
    await scheduleSignupBatch(t.db, { actor: "fundador", now: MONDAY_NIGHT });
    clock = new Date(TUESDAY_10.getTime() + 50 * 60_000);
    const meta = fakeMeta();
    expect(await run(meta.client)).toEqual({ ran: false, why: "missed" });
    expect(meta.sent).toHaveLength(0);
    expect((await batchSchedule(t.db))?.status).toBe("missed");
    expect((await signupRescueSettings(t.db)).template).toBe(false);
  });

  it("S1: con el interruptor apagado antes de la hora no sale nada (se negó)", async () => {
    await backlog(2);
    await scheduleSignupBatch(t.db, { actor: "fundador", now: MONDAY_NIGHT });
    await saveSignupRescueSettings(t.db, { template: false }, "fundador", MONDAY_NIGHT);
    const meta = fakeMeta();
    const r = await run(meta.client);
    expect(r).toMatchObject({ ran: true, result: null });
    expect(meta.sent).toHaveLength(0);
    expect(await batchSchedule(t.db)).toMatchObject({ status: "refused" });
  });

  it("cancelar lo deja sin hacer y apaga el interruptor; sin nadie a quien enviar, no se programa", async () => {
    await expect(
      scheduleSignupBatch(t.db, { actor: "fundador", now: MONDAY_NIGHT }),
    ).rejects.toBeInstanceOf(BatchRefused);
    await backlog(1);
    await scheduleSignupBatch(t.db, { actor: "fundador", now: MONDAY_NIGHT });
    expect(await cancelSignupBatch(t.db, "fundador", MONDAY_NIGHT)).toBe(true);
    expect((await batchSchedule(t.db))?.status).toBe("cancelled");
    expect((await signupRescueSettings(t.db)).template).toBe(false);
    const meta = fakeMeta();
    expect(await run(meta.client)).toEqual({ ran: false, why: "none" });
    expect(meta.sent).toHaveLength(0);
  });
});
