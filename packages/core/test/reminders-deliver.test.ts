import { eq, schema } from "@caja/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { businessDateOf, type IsoDate } from "../src/domain/dates";
import { saveHabitSettings } from "../src/ledger/habits";
import { deliverReminders, earlyAt } from "../src/reminders/deliver";
import { botHarness, CASHIER, idsOf, OWNER, textOf } from "./bot-harness";

/** Entrega de recordatorios (PRD hábitos US-304 a US-306): caminos a, b y c, y vencidos. */
const H = 3_600_000;
const MIN = 60_000;

describe("earlyAt: el aviso adelantado nunca de noche", () => {
  const at = (iso: string) => earlyAt(new Date(iso))?.toISOString() ?? null;
  it("23 h después del último mensaje, o a las 8 pm de antes", () => {
    // 10:00 Caracas → 09:00 del día siguiente.
    expect(at("2026-11-10T14:00:00Z")).toBe("2026-11-11T13:00:00.000Z");
    // 22:00 Caracas → caería 21:00 (de noche) → 20:00 del día siguiente.
    expect(at("2026-11-11T02:00:00Z")).toBe("2026-11-12T00:00:00.000Z");
    // 03:00 Caracas → caería 02:00 → 20:00 del mismo día del mensaje.
    expect(at("2026-11-10T07:00:00Z")).toBe("2026-11-11T00:00:00.000Z");
    // 20:30 Caracas → caería 19:30: sale a su hora.
    expect(at("2026-11-11T00:30:00Z")).toBe("2026-11-11T23:30:00.000Z");
  });
});

describe("entrega de recordatorios", () => {
  let h: Awaited<ReturnType<typeof botHarness>>;
  let phoneId: string;
  const meta = () => h.deps().metaFor("x");
  const rows = () => h.t.db.select().from(schema.reminder);
  const sentTo = (phone = OWNER) => h.sent.filter((s) => s.to === phone);

  /** Un mensaje del dueño a esa hora (abre la ventana de servicio). */
  const inbound = (at: Date) =>
    h.t.db.insert(schema.message).values({
      tenantId: h.tenantId,
      phoneId,
      direction: "in",
      kind: "text",
      body: "hola",
      createdAt: at,
    });
  const reminder = (dueAt: Date, extra: Partial<typeof schema.reminder.$inferInsert> = {}) =>
    h.t.db
      .insert(schema.reminder)
      .values({
        tenantId: h.tenantId,
        phoneId,
        text: "pagar la luz",
        kind: "pay",
        amount: "20.00",
        currency: "USD",
        dueAt,
        dueDate: businessDateOf(dueAt) as IsoDate,
        ...extra,
      })
      .returning()
      .then((r) => r[0]);

  beforeAll(async () => {
    h = await botHarness();
    const [p] = await h.t.db
      .select()
      .from(schema.phoneNumber)
      .where(eq(schema.phoneNumber.e164, OWNER));
    phoneId = p?.id ?? "";
  });
  afterAll(() => h.t.close());
  beforeEach(async () => {
    await saveHabitSettings(h.t.db, { reminders: true, prefs: false }, "test", new Date());
    await h.t.db.delete(schema.reminder);
    await h.t.db.delete(schema.message);
    h.sent.length = 0;
  });

  it("con el interruptor apagado no hace nada", async () => {
    await saveHabitSettings(h.t.db, { reminders: false }, "test", new Date());
    const now = new Date();
    await inbound(new Date(now.getTime() - H));
    await reminder(new Date(now.getTime() - MIN));
    expect(await deliverReminders(h.t.db, meta(), { now })).toMatchObject({ a: 0, b: 0 });
    expect(h.sent).toHaveLength(0);
  });

  it("camino a: a su hora, con Ya lo hice y Recuérdame mañana; una sola vez", async () => {
    const now = new Date();
    await inbound(new Date(now.getTime() - H));
    const r = await reminder(new Date(now.getTime() - MIN));
    expect((await deliverReminders(h.t.db, meta(), { now })).a).toBe(1);
    const out = sentTo().at(-1);
    expect(textOf(out)).toBe("⏰ Pagar la luz · $20,00\nSi ya pagaste, dime cuánto y lo anoto.");
    expect(idsOf(out)).toEqual([`rem:done:${r?.id}`, `rem:snooze:${r?.id}`]);
    const [after] = await rows();
    expect(after).toMatchObject({ status: "delivered", deliveredVia: "a" });
    // La marca lleva solo los ids, nunca el texto.
    const [m] = await h.t.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.direction, "out"));
    expect(m?.toolCalls).toEqual([{ name: "reminder_a", args: { ids: [r?.id] } }]);
    expect((await deliverReminders(h.t.db, meta(), { now })).a).toBe(0);
    expect(sentTo()).toHaveLength(1);
  });

  it("camino a: varios a la vez van juntos, con la lista", async () => {
    const now = new Date();
    await inbound(new Date(now.getTime() - H));
    await reminder(new Date(now.getTime() - 2 * MIN));
    await reminder(new Date(now.getTime() - MIN), { text: "cobrarle a Pedro", kind: "collect" });
    await deliverReminders(h.t.db, meta(), { now });
    const out = sentTo().at(-1);
    expect(textOf(out)).toBe(
      "⏰ Te recuerdo:\n• Pagar la luz · $20,00\n• Cobrarle a Pedro · $20,00",
    );
    expect(idsOf(out)).toEqual(["rem:list"]);
  });

  it("ventana cerrada: no sale y espera al camino c", async () => {
    const now = new Date();
    await inbound(new Date(now.getTime() - 25 * H));
    await reminder(new Date(now.getTime() - MIN));
    const r = await deliverReminders(h.t.db, meta(), { now });
    expect(r.a).toBe(0);
    expect(r.denied.window_closed).toBe(1);
    expect((await rows())[0]?.status).toBe("pending");
  });

  it("«no me escribas» frena el camino a", async () => {
    const now = new Date();
    await inbound(new Date(now.getTime() - H));
    await reminder(new Date(now.getTime() - MIN));
    await h.t.db
      .update(schema.phoneNumber)
      .set({ unsolicitedOffAt: now })
      .where(eq(schema.phoneNumber.id, phoneId));
    const r = await deliverReminders(h.t.db, meta(), { now });
    await h.t.db
      .update(schema.phoneNumber)
      .set({ unsolicitedOffAt: null })
      .where(eq(schema.phoneNumber.id, phoneId));
    expect(r.denied.opted_out).toBe(1);
    expect(h.sent).toHaveLength(0);
  });

  it("camino b: 23 h después del último mensaje, si vence cuando la ventana ya cerró", async () => {
    // Mediodía de Caracas: lejos del horario nocturno.
    const now = new Date(`${businessDateOf(new Date())}T16:00:00Z`);
    const last = new Date(now.getTime() - 23 * H - 10 * MIN);
    await inbound(last);
    const r = await reminder(new Date(last.getTime() + 24 * H + 2 * 24 * H));
    expect((await deliverReminders(h.t.db, meta(), { now })).b).toBe(1);
    const out = sentTo().at(-1);
    expect(textOf(out)).toContain("Te lo adelanto porque, si no me escribes antes");
    expect(idsOf(out)).toEqual([`rem:done:${r?.id}`, "pref:nudges_off"]);
    const [after] = await rows();
    expect(after?.status).toBe("pending");
    expect(after?.earlySentAt).not.toBeNull();
    // Uno por recordatorio.
    expect((await deliverReminders(h.t.db, meta(), { now })).b).toBe(0);
  });

  it("camino b: antes de las 23 h todavía no", async () => {
    const now = new Date(`${businessDateOf(new Date())}T16:00:00Z`);
    const last = new Date(now.getTime() - 20 * H);
    await inbound(last);
    await reminder(new Date(last.getTime() + 3 * 24 * H));
    expect((await deliverReminders(h.t.db, meta(), { now })).b).toBe(0);
  });

  it("más de 7 días vencido sin entregar: expired", async () => {
    const now = new Date();
    await reminder(new Date(now.getTime() - 8 * 24 * H));
    expect((await deliverReminders(h.t.db, meta(), { now })).expired).toBe(1);
    expect((await rows())[0]?.status).toBe("expired");
  });

  it("camino c: arriba de la próxima respuesta del dueño, una vez; nunca al empleado", async () => {
    await reminder(new Date(Date.now() - 3 * H));
    const body = await h.send("hola", CASHIER);
    expect(body).not.toContain("Tenías pendiente");
    const owner = await h.send("hola");
    expect(owner.startsWith("⏰ Tenías pendiente: pagar la luz · $20,00 (")).toBe(true);
    expect((await rows())[0]).toMatchObject({ status: "delivered", deliveredVia: "c" });
    expect(await h.send("hola")).not.toContain("Tenías pendiente");
  });

  it("camino c: no va en las tarjetas de avisos (US-306)", async () => {
    await saveHabitSettings(h.t.db, { prefs: true }, "test", new Date());
    await reminder(new Date(Date.now() - 3 * H));
    const card = await h.send("no me recuerdes");
    expect(card).not.toContain("Tenías pendiente");
    expect((await rows())[0]?.status).toBe("pending");
    await h.t.db.update(schema.phoneNumber).set({ prefPending: null, prefPendingAt: null });
  });
});
