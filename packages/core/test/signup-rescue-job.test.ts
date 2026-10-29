import { eq, schema, sql } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  inHoldout,
  runSignupRescue,
  saveSignupRescueSettings,
  signupRescueSettings,
} from "../src/onboarding/signup-rescue";
import { es } from "../src/render/index";
import { MetaClient } from "../src/whatsapp/client";

/** Recordatorio (A) del registro (US-SR-05) y sus textos (US-SR-06). */
const H = 3_600_000;
const MIN = 60_000;
/** 12:00 de Caracas. */
const NOON = new Date("2026-11-10T16:00:00Z");

function fakeMeta(fail: number | null = null) {
  const sent: { to: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (fail !== null)
      return new Response(JSON.stringify({ error: { message: "x", code: fail } }), { status: 400 });
    sent.push({ to: String(body.to), body });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.R${sent.length}` }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { sent, client: new MetaClient({ accessToken: "T", phoneNumberId: "P", fetchImpl }) };
}

describe("recordatorio del registro (A)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let n = 0;
  const signup = async (
    updatedAt: Date,
    extra: Partial<typeof schema.signup.$inferInsert> = {},
  ) => {
    const e164 = `58424000${String(++n).padStart(4, "0")}`;
    const [r] = await t.db
      .insert(schema.signup)
      .values({
        e164,
        step: "currency",
        data: { name: "Ana", kind: "personal" },
        messages: 3,
        updatedAt,
        ...extra,
      })
      .returning();
    return r as typeof schema.signup.$inferSelect;
  };
  const get = async (id: string) =>
    (await t.db.select().from(schema.signup).where(eq(schema.signup.id, id)))[0];
  const on = (since = new Date(NOON.getTime() - 10 * 24 * H), holdoutPct = 0) =>
    saveSignupRescueSettings(t.db, { inWindow: true, holdoutPct }, "test", since);

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.db.delete(schema.signup);
    await t.db.delete(schema.appSetting).where(eq(schema.appSetting.key, "signup_rescue"));
  });

  it("apagado: no hace nada", async () => {
    const r = await signup(new Date(NOON.getTime() - 4 * H));
    const m = fakeMeta();
    expect((await runSignupRescue(t.db, m.client, { now: NOON })).sent).toBe(0);
    expect((await get(r.id))?.rescueVia).toBeNull();
  });

  it("a las 3 h con la ventana abierta sale una vez (dos corridas, un envío), con SR-A3", async () => {
    await on();
    const r = await signup(new Date(NOON.getTime() - 3 * H - MIN));
    const m = fakeMeta();
    expect((await runSignupRescue(t.db, m.client, { now: NOON })).sent).toBe(1);
    expect((await runSignupRescue(t.db, m.client, { now: NOON })).sent).toBe(0);
    expect(m.sent).toHaveLength(1);
    const interactive = m.sent[0]?.body.interactive as {
      body: { text: string };
      action: { buttons: { reply: { id: string; title: string } }[] };
    };
    expect(interactive.body.text).toBe(
      "Hola, Ana. Quedó a medias tu cuenta de Rocco: te faltan 3 pasos para que puedas anotar tus gastos.\n¿Seguimos donde quedamos?",
    );
    expect(interactive.action.buttons.map((b) => b.reply.id)).toEqual([
      "signup:resume",
      "signup:stop",
    ]);
    expect(await get(r.id)).toMatchObject({ rescueVia: "window", rescueWaMessageId: "wamid.R1" });
  });

  it("CC-1: un updated_at con microsegundos (default de la base) igual se marca y sale SR-A1", async () => {
    await on();
    const [r] = await t.db
      .insert(schema.signup)
      .values({
        e164: "584240009999",
        step: "name",
        data: {},
        messages: 1,
        updatedAt: sql`'2026-11-10 12:59:00.123456+00'::timestamptz` as unknown as Date,
      })
      .returning();
    const m = fakeMeta();
    const out = await runSignupRescue(t.db, m.client, { now: NOON });
    expect(out.sent).toBe(1);
    const body =
      (m.sent[0]?.body.interactive as { body?: { text?: string } } | undefined)?.body?.text ?? "";
    expect(body.startsWith("Hola. Quedó a medias tu cuenta de Rocco.")).toBe(true);
    expect((await get(r?.id as string))?.rescueVia).toBe("window");
  });

  it("escribió hace 2 h 59: nada todavía", async () => {
    await on();
    await signup(new Date(NOON.getTime() - 3 * H + MIN));
    expect((await runSignupRescue(t.db, fakeMeta().client, { now: NOON })).sent).toBe(0);
  });

  it("vence de noche: sale en la corrida de las 8:00 si la ventana sigue abierta; si no, nunca", async () => {
    await on();
    // 19:00 de Caracas → vence 22:00 (de noche); la ventana sigue abierta a las 8:00.
    const evening = await signup(new Date("2026-11-10T23:00:00Z"));
    // 08:10 de Caracas del día anterior: a las 8:00 ya pasaron más de 23 h 30.
    const stale = await signup(new Date("2026-11-10T12:10:00Z"));
    const m = fakeMeta();
    const night = await runSignupRescue(t.db, m.client, { now: new Date("2026-11-11T02:00:00Z") });
    expect(night).toMatchObject({ quiet: true, sent: 0 });
    // 08:00 de Caracas.
    await runSignupRescue(t.db, m.client, { now: new Date("2026-11-11T12:00:00Z") });
    expect((await get(evening.id))?.rescueVia).toBe("window");
    expect((await get(stale.id))?.rescueVia).toBeNull();
    expect(m.sent).toHaveLength(1);
  });

  it("no le escribe a quien dijo no, marcó el fundador, terminó, ya es cliente o es de antes del interruptor", async () => {
    await on(new Date(NOON.getTime() - 5 * H));
    const at = new Date(NOON.getTime() - 4 * H);
    await signup(at, { contactOffAt: at });
    await signup(at, { founderContactedAt: at });
    await signup(at, { completedAt: at, step: "done" });
    const client = await signup(at);
    await seedTenant(t.db, { name: "X", businessType: "retail", ownerPhone: client.e164 });
    await signup(new Date(NOON.getTime() - 6 * H));
    const m = fakeMeta();
    expect((await runSignupRescue(t.db, m.client, { now: NOON })).sent).toBe(0);
    expect(m.sent).toHaveLength(0);
  });

  it("grupo de control: marcado holdout, nada sale", async () => {
    await on(undefined, 100);
    const r = await signup(new Date(NOON.getTime() - 4 * H));
    const m = fakeMeta();
    expect((await runSignupRescue(t.db, m.client, { now: NOON })).holdout).toBe(1);
    expect(m.sent).toHaveLength(0);
    expect((await get(r.id))?.rescueVia).toBe("holdout");
    expect(inHoldout(r.id, 0)).toBe(false);
  });

  it("Meta falla: la marca queda (su único mensaje) y se cuenta el código", async () => {
    await on();
    const r = await signup(new Date(NOON.getTime() - 4 * H));
    const out = await runSignupRescue(t.db, fakeMeta(131047).client, { now: NOON });
    expect(out).toMatchObject({ failed: 1, failedByCode: { "131047": 1 } });
    expect((await get(r.id))?.rescueVia).toBe("window");
  });

  it("como plantilla: manda la plantilla con los dos payloads", async () => {
    await saveSignupRescueSettings(
      t.db,
      { inWindow: true, holdoutPct: 0, inWindowVia: "template" },
      "test",
      new Date(NOON.getTime() - 24 * H),
    );
    await signup(new Date(NOON.getTime() - 4 * H));
    const m = fakeMeta();
    await runSignupRescue(t.db, m.client, {
      now: NOON,
      template: { name: "rocco_registro_pendiente", language: "es" },
    });
    expect(m.sent[0]?.body.template).toEqual({
      name: "rocco_registro_pendiente",
      language: { code: "es" },
      components: [
        {
          type: "button",
          sub_type: "quick_reply",
          index: "0",
          parameters: [{ type: "payload", payload: "signup:resume" }],
        },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "1",
          parameters: [{ type: "payload", payload: "signup:stop" }],
        },
      ],
    });
  });

  it("encender guarda desde cuándo; apagar no lo borra", async () => {
    const at = new Date("2026-11-01T12:00:00Z");
    await saveSignupRescueSettings(t.db, { inWindow: true }, "test", at);
    await saveSignupRescueSettings(t.db, { inWindow: false }, "test", NOON);
    expect(await signupRescueSettings(t.db)).toMatchObject({
      inWindow: false,
      inWindowSince: at.toISOString(),
      holdoutPct: 20,
    });
  });
});

describe("textos SR-A1…A4 (US-SR-06)", () => {
  it("cada variante: cuerpo ≤ 1.024, títulos ≤ 20, con y sin nombre", () => {
    const steps = [
      "name",
      "kind",
      "biz_name",
      "biz_type",
      "currency",
      "categories",
      "accounts",
      "accounts_confirm",
      "budget",
    ] as const;
    for (const step of steps)
      for (const name of ["Ana María", null]) {
        const o = es.signupRescue(step, name, 3);
        expect(o.type).toBe("buttons");
        if (o.type !== "buttons") continue;
        expect(o.body.length).toBeLessThanOrEqual(1024);
        expect(o.buttons.every((b) => b.title.length <= 20)).toBe(true);
        if (step === "name" || !name) expect(o.body.startsWith("Hola.")).toBe(true);
      }
    expect(es.signupRescue("budget", "Ana", 1).body).toBe(
      "Hola, Ana. Tu cuenta de Rocco está casi lista: solo falta un paso, y es opcional.\n¿La terminamos?",
    );
    expect(es.signupRescue("kind", "Ana", 5).body).toBe(
      "Hola, Ana. Quedó a medias tu cuenta de Rocco. Faltan unas preguntas cortas, casi todas con botones, y después ya puedes anotar tus gastos.\n¿Seguimos?",
    );
  });
});

describe("contadores del registro (US-SR-10)", () => {
  it("suma por día sin pisarse y se leen por rango", async () => {
    const { createTestDb: mk } = await import("@caja/db/testing");
    const { bumpSignupCounts, signupCountsByDay, sumCounts } = await import(
      "../src/onboarding/signup-counts"
    );
    const t = await mk();
    try {
      await Promise.all([
        bumpSignupCounts(t.db, NOON, { sends: 2, "resume:window": 1 }),
        bumpSignupCounts(t.db, NOON, { sends: 3, stop_word: 1 }),
      ]);
      await bumpSignupCounts(t.db, new Date(NOON.getTime() + 24 * H), { sends: 1 });
      const days = await signupCountsByDay(t.db, "2026-11-10", "2026-11-11");
      expect(days.map((d) => d.day)).toEqual(["2026-11-10", "2026-11-11"]);
      expect(days[0]?.counts).toEqual({ sends: 5, "resume:window": 1, stop_word: 1 });
      expect(sumCounts(days.map((d) => d.counts)).sends).toBe(6);
    } finally {
      await t.close();
    }
  });
});
