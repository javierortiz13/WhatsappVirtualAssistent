import { eq, schema, withTenant } from "@caja/db";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleSignup, parsePersonName, type SignupInput } from "../src/onboarding/chat-signup";
import { es } from "../src/render/index";

/** Recordatorios del registro (PRD signup-reminders v1.2): US-SR-02, US-SR-03, US-SR-04. */
const H = 3_600_000;
const cfg = { dashboardUrl: "https://caja.test" };
const textOf = (o: { body?: string } | undefined) => o?.body ?? "";
const STOP = es.signupStopped().body;

describe("registro: «no me escribas», «Seguir» y el regreso", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let n = 0;
  const num = () => `58414000${String(++n).padStart(4, "0")}`;
  const input = (e164: string, x: Partial<SignupInput>): SignupInput => ({
    e164,
    waUserId: null,
    profileName: "Ana",
    text: null,
    replyId: null,
    ...x,
  });
  const say = (e164: string, text: string, now: Date) =>
    handleSignup(t.db, input(e164, { text }), cfg, now);
  const tap = (e164: string, replyId: string, now: Date) =>
    handleSignup(t.db, input(e164, { replyId }), cfg, now);
  const row = async (e164: string) =>
    (await t.db.select().from(schema.signup).where(eq(schema.signup.e164, e164)))[0];
  /** Lleva un número hasta `currency` (personal). */
  async function toCurrency(e164: string, at: Date) {
    await say(e164, "hola", at);
    await say(e164, "Ana", at);
    await tap(e164, "signup:kind:personal", at);
  }

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(() => t.close());

  it("«no me escribas» como primer mensaje: SR-STOP en vez de la presentación", async () => {
    const e = num();
    const r = await say(e, "No me escribas", new Date());
    expect(r.outbound.map(textOf)).toEqual([STOP]);
    expect((await row(e))?.contactOffAt).not.toBeNull();
  });

  it("«no me escribas» en el nombre: SR-STOP, no se guarda como nombre; «hola» después sigue", async () => {
    const e = num();
    const at = new Date();
    await say(e, "hola", at);
    const r = await say(e, "no me escribas", at);
    expect(r.outbound.map(textOf)).toEqual([STOP]);
    const after = await row(e);
    expect(after?.step).toBe("name");
    expect((after?.data as { name?: string }).name).toBeUndefined();
    expect(after?.contactOffAt).not.toBeNull();
    expect(parsePersonName("No Me Escribas")).toBeNull();
    await say(e, "Ana", at);
    expect((await row(e))?.step).toBe("kind");
    expect((await row(e))?.contactOffAt).not.toBeNull();
  });

  it("«stop» en categorías y el toque signup:stop: SR-STOP, lo respondido queda", async () => {
    const e = num();
    const at = new Date();
    await toCurrency(e, at);
    await tap(e, "signup:cur:USD", at);
    expect((await row(e))?.step).toBe("categories");
    expect((await say(e, "stop", at)).outbound.map(textOf)).toEqual([STOP]);
    expect((await row(e))?.step).toBe("categories");
    expect((await tap(e, "signup:stop", at)).outbound.map(textOf)).toEqual([STOP]);
  });

  it("la lista negativa de US-204 no apaga", async () => {
    for (const phrase of ["para la luz 20$", "baja de precio el pan", "stop de la moto"]) {
      const e = num();
      const at = new Date();
      await say(e, "hola", at);
      const r = await say(e, phrase, at);
      expect(r.outbound.map(textOf)).not.toContain(STOP);
      expect((await row(e))?.contactOffAt).toBeNull();
    }
  });

  it("US-SR-03: quien pidió no recibir mensajes y termina queda apagado en la cuenta", async () => {
    const e = num();
    const at = new Date();
    await toCurrency(e, at);
    await say(e, "no me escribas", at);
    await tap(e, "signup:cur:USD", at);
    await tap(e, "signup:cat:ok", at);
    const done = await tap(e, "signup:bud:skip", at);
    expect(done.step).toBe("done");
    expect(textOf(done.outbound.at(-1))).toContain(es.SIGNUP_STOP_DONE_LINE);
    const tenantId = done.created?.tenantId as string;
    const [phone] = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.phoneNumber).where(eq(schema.phoneNumber.e164, e)),
    );
    expect(phone?.unsolicitedOffAt).not.toBeNull();
    const [a] = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.auditLog).where(eq(schema.auditLog.action, "all_off")),
    );
    expect(a?.after).toEqual({ source: "signup", text_id: "SR-STOP", text_version: "v1.1" });
  });

  it("sin «no me escribas», el tour no lleva la línea y el teléfono queda encendido", async () => {
    const e = num();
    const at = new Date();
    await toCurrency(e, at);
    await tap(e, "signup:cur:USD", at);
    await tap(e, "signup:cat:ok", at);
    const done = await tap(e, "signup:bud:skip", at);
    expect(textOf(done.outbound.at(-1))).not.toContain(es.SIGNUP_STOP_DONE_LINE);
  });

  it("«Seguir» en moneda: solo la pregunta, un mensaje", async () => {
    const e = num();
    const at = new Date(Date.now() - 10 * H);
    await toCurrency(e, at);
    const r = await tap(e, "signup:resume", new Date());
    expect(r.outbound).toHaveLength(1);
    expect(r.outbound[0]).toEqual(es.signupAskCurrency(false, { n: 3, total: 4 }));
  });

  it("respaldo de la plantilla: «Seguir» como payload solo vale con rescue_via = template", async () => {
    const e = num();
    const at = new Date(Date.now() - 30 * H);
    await toCurrency(e, at);
    await t.db
      .update(schema.signup)
      .set({ rescueVia: "template", rescueAt: new Date(Date.now() - H) })
      .where(eq(schema.signup.e164, e));
    expect((await tap(e, "Seguir", new Date())).outbound).toHaveLength(1);
    expect((await tap(e, "No me escribas", new Date())).outbound.map(textOf)).toEqual([STOP]);
  });

  it("el regreso se mide desde el recordatorio: «sí» 4 h después en categorías es cat:ok; 7 h, bienvenida", async () => {
    const e = num();
    const start = new Date(Date.now() - 20 * H);
    await toCurrency(e, start);
    await tap(e, "signup:cur:USD", start);
    const rescueAt = new Date(start.getTime() + 3 * H);
    await t.db
      .update(schema.signup)
      .set({ rescueAt, rescueVia: "window" })
      .where(eq(schema.signup.e164, e));
    const r = await say(e, "sí", new Date(rescueAt.getTime() + 4 * H));
    expect((await row(e))?.step).toBe("budget");
    expect(r.outbound).toHaveLength(2);

    const e2 = num();
    await toCurrency(e2, start);
    await tap(e2, "signup:cur:USD", start);
    await t.db
      .update(schema.signup)
      .set({ rescueAt, rescueVia: "window" })
      .where(eq(schema.signup.e164, e2));
    const late = await say(e2, "sí", new Date(rescueAt.getTime() + 7 * H));
    expect((await row(e2))?.step).toBe("categories");
    expect(textOf(late.outbound[0])).toContain("Qué bueno");
  });
});

describe("toques viejos del recordatorio desde una cuenta (US-SR-04)", () => {
  it("signup:resume muestra el menú; signup:stop es como escribir «no me escribas»", async () => {
    const { botHarness } = await import("./bot-harness");
    const { saveHabitSettings } = await import("../src/ledger/habits");
    const h = await botHarness();
    try {
      expect(await h.tap("signup:resume", "Seguir")).toContain("¿Qué quieres hacer?");
      await saveHabitSettings(h.t.db, { prefs: true }, "test", new Date());
      const typed = await h.send("no me escribas");
      await h.t.db.update(schema.phoneNumber).set({ prefPending: null, prefPendingAt: null });
      expect(await h.tap("signup:stop", "No me escribas")).toBe(typed);
    } finally {
      await h.t.close();
    }
  });
});
