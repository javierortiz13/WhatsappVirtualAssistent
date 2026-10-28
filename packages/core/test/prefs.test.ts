import { eq, schema, withTenant } from "@caja/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isQuietHours, takeUnsolicitedSlot } from "../src/inbox/gate";
import { sendLifecycleNotices } from "../src/inbox/lifecycle";
import { classifyPref, setDashboardPref } from "../src/inbox/prefs";
import { saveHabitSettings } from "../src/ledger/habits";
import { consentTextVersion } from "../src/render/es-VE";
import { botHarness, CASHIER, idsOf, OWNER } from "./bot-harness";

/** Apagar y encender avisos (PRD hábitos US-204, US-211) y la puerta de envíos (US-203). */
describe("classifyPref: el mensaje entero, nada más", () => {
  it("frases que apagan, encienden y consultan", () => {
    expect(classifyPref("No me recuerdes")).toBe("nudges_off");
    expect(classifyPref("no me recuerdes más.")).toBe("nudges_off");
    expect(classifyPref("STOP")).toBe("all_off");
    expect(classifyPref("Para!")).toBe("all_off");
    expect(classifyPref("no me escribas")).toBe("all_off");
    expect(classifyPref("Avísame a las 8 pm")).toBe("nudges_on");
    expect(classifyPref("ya puedes escribirme")).toBe("all_on");
    expect(classifyPref("actívame los avisos")).toBe("both_on");
    expect(classifyPref("mis avisos")).toBe("status");
  });
  it("frases parecidas que no son esto (negativos del PRD)", () => {
    for (const t of [
      "para la luz 20$",
      "pagué 5$ para el cumpleaños",
      "no me escribas el gasto dos veces",
      "no me recuerdes la tasa, dime cuánto es",
      "stop de la moto 10$",
      "baja de precio el pan",
      "paré a echar gasolina 15$",
      "activa la cuenta Banesco",
      "avísame cuando llegue la tasa",
      "ya puedes escribirme el total",
    ])
      expect(classifyPref(t), t).toBeNull();
  });
});

describe("apagar y encender avisos por chat", () => {
  let h: Awaited<ReturnType<typeof botHarness>>;
  const phone = async (e164 = OWNER) => {
    const [p] = await h.t.db
      .select()
      .from(schema.phoneNumber)
      .where(eq(schema.phoneNumber.e164, e164));
    if (!p) throw new Error("sin teléfono");
    return p;
  };
  const consents = async () =>
    (
      await h.t.db
        .select({ action: schema.auditLog.action, after: schema.auditLog.after })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.entity, "phone_number"))
    ).map(
      (r) =>
        ({ action: r.action, ...(r.after as Record<string, string>) }) as Record<string, string>,
    );
  beforeAll(async () => {
    h = await botHarness();
  });
  afterAll(() => h.t.close());
  beforeEach(async () => {
    await saveHabitSettings(h.t.db, { prefs: true }, "test", new Date());
    await h.t.db.update(schema.phoneNumber).set({
      nudgeOptInAt: null,
      nudgeOffAt: null,
      unsolicitedOffAt: null,
      nudgePausedUntil: null,
      prefPending: null,
      prefPendingAt: null,
    });
    await h.t.db.delete(schema.auditLog);
    await h.t.db.update(schema.tenant).set({ crmTags: [], status: "trial" });
  });

  it("con el interruptor apagado, las frases van a la IA como siempre", async () => {
    await saveHabitSettings(h.t.db, { prefs: false }, "test", new Date());
    const calls = h.llm.calls;
    await h.send("no me escribas");
    expect(h.llm.calls).toBe(calls + 1);
  });

  it("«no me recuerdes» → H45-n (nunca aceptó el aviso), pendiente desde ya; «Sí» → H11-n", async () => {
    const calls = h.llm.calls;
    const card = await h.send("No me recuerdes");
    expect(h.llm.calls).toBe(calls);
    expect(card).toBe(
      "¿Apago los avisos adelantados de tus recordatorios?\nHasta que me contestes, no te los mando. Los recordatorios que pidas te siguen llegando a su hora o cuando me escribas.",
    );
    expect(idsOf(h.last())).toEqual(["pref:yes:nudges_off", "pref:keep:nudges_off"]);
    expect((await phone()).prefPending).toBe("nudges_off");
    expect(await h.tap("pref:yes:nudges_off", "Sí, apágalos")).toBe(
      "Listo, ya no te adelanto recordatorios. Los que me pidas te llegan a su hora o cuando me escribas. Para volver a recibir avisos: *actívame los avisos*.",
    );
    const p = await phone();
    expect(p.nudgeOffAt).not.toBeNull();
    expect(p.prefPending).toBeNull();
    expect(await consents()).toEqual([
      { action: "nudge_off", source: "button", text_id: "H45-n", text_version: "v1.2.1" },
    ]);
    // Otra vez: ya estaban apagados, sin tarjeta.
    expect(await h.tap("pref:yes:nudges_off", "Sí, apágalos")).toMatch(
      /^El aviso de racha y los avisos adelantados ya estaban apagados/,
    );
    expect(await h.send("no me recuerdes")).toMatch(/ya estaban apagados/);
  });

  it("con el aviso aceptado sale H45 con las dos viñetas y «Sí» responde H11", async () => {
    await h.t.db.update(schema.phoneNumber).set({ nudgeOptInAt: new Date() });
    expect(await h.send("apaga los avisos")).toMatch(
      /^¿Apago estos avisos\?\n• El aviso de racha de las 8 pm\n• Los avisos adelantados/,
    );
    expect(await h.tap("pref:yes:nudges_off")).toMatch(
      /^Listo, ya no te aviso de la racha ni te adelanto recordatorios/,
    );
    expect((await consents())[0]).toMatchObject({ text_id: "H45", text_version: "v1.2" });
  });

  it("«no me escribas» → H46; un «No» en una H45 vieja vuelve a mostrar H46; el «No» de H46 → H48", async () => {
    await h.send("no me recuerdes");
    const card = await h.send("Stop");
    expect(card).toMatch(/^¿Apago los mensajes que te mando por mi cuenta\?/);
    expect(card).toContain("Los avisos de un pago tuyo o del borrado de tus datos llegan igual.");
    expect((await phone()).prefPending).toBe("all_off");
    expect(await h.tap("pref:keep:nudges_off", "No, déjalos")).toMatch(/^¿Apago los mensajes/);
    expect((await phone()).prefPending).toBe("all_off");
    // «mis avisos» con la tarjeta pendiente: la misma tarjeta.
    expect(await h.send("mis avisos")).toMatch(/^¿Apago los mensajes/);
    expect(await h.tap("pref:keep:all_off", "No, déjalos")).toBe(
      "Dale, no apago nada y todo queda como estaba.",
    );
    expect((await phone()).prefPending).toBeNull();
    expect(await consents()).toEqual([]);
  });

  it("«Sí» en H46 → H12; encender después → H13c-all y dos consentimientos", async () => {
    await h.send("no me escribas");
    expect(await h.tap("pref:yes:all_off")).toBe(
      "Listo, ya no te escribo por mi cuenta, salvo avisos sobre un pago tuyo o el borrado de tus datos. Tus recordatorios te los muestro cuando me escribas. Para volver: *ya puedes escribirme*.",
    );
    expect(await h.send("no me recuerdes")).toBe(
      "Los mensajes que te mando por mi cuenta ya estaban apagados. Para volver: *ya puedes escribirme*.",
    );
    expect(await h.send("mis avisos")).toMatch(/^No te escribo por mi cuenta/);
    expect(await h.send("Actívame los avisos")).toMatch(
      /^Listo, vuelvo a escribirte por mi cuenta y encendí el aviso de racha/,
    );
    const p = await phone();
    expect(p.unsolicitedOffAt).toBeNull();
    expect(p.nudgeOptInAt).not.toBeNull();
    expect((await consents()).map((c) => [c.action, c.text_id])).toEqual([
      ["all_off", "H46"],
      ["nudge_opt_in", "H13c-all"],
      ["all_on", "H13c-all"],
    ]);
    expect(await h.send("activa los avisos")).toBe(
      "Eso ya estaba encendido. Para ver tus avisos o cambiarlos: *mis avisos*.",
    );
    expect(await h.send("mis avisos")).toMatch(/^Tus avisos están encendidos/);
  });

  it("la etiqueta no-contactar: encender da H13d-tag con el correo; apagar da H49", async () => {
    await h.t.db.update(schema.tenant).set({ crmTags: ["No-Contactar"] });
    expect(await h.send("ya puedes escribirme")).toBe(
      "Tus avisos los apagó el equipo de Rocco. Para volver a recibirlos, escríbenos a privacidad@caja.test",
    );
    expect(await h.send("no me escribas")).toMatch(/ya estaban apagados/);
  });

  it("cuenta suspendida: apagar funciona y encender avisa que no llegan (R-2 a)", async () => {
    await h.t.db.update(schema.tenant).set({ status: "suspended" });
    expect(await h.send("no me escribas")).toMatch(/^¿Apago los mensajes/);
    expect(await h.send("avísame a las 8")).toMatch(
      /para apagarlo: \*no me recuerdes\*\.\nMientras tu cuenta esté suspendida o sin mensajes disponibles, estos avisos no te llegan\.$/i,
    );
  });

  it("empleado: los avisos son del dueño; «ya puedes escribirme» limpia su teléfono", async () => {
    expect(await h.send("mis avisos", CASHIER)).toBe(
      "El aviso de racha y los recordatorios son solo para el dueño de la cuenta.",
    );
    await h.t.db
      .update(schema.phoneNumber)
      .set({ unsolicitedOffAt: new Date() })
      .where(eq(schema.phoneNumber.e164, CASHIER));
    expect(await h.send("ya puedes escribirme", CASHIER)).toBe(
      "Listo. El aviso de racha y los recordatorios son solo para el dueño de la cuenta.",
    );
    expect((await phone(CASHIER)).unsolicitedOffAt).toBeNull();
  });

  it("ayuda con la línea de avisos; menú con la línea si tiene algo apagado", async () => {
    expect(await h.send("ayuda")).toContain(
      "• Avisos: _mis avisos_ para verlos, encenderlos o apagarlos",
    );
    expect(await h.send("menu")).not.toContain("Tienes avisos apagados");
    await h.t.db.update(schema.phoneNumber).set({ nudgeOffAt: new Date() });
    expect(await h.send("menu")).toContain(
      "Tienes avisos apagados. Para verlos o encenderlos: *mis avisos*.",
    );
  });

  it("«no me escribas» salta la encuesta del día 10 y la deja marcada; el fin de la prueba no sale nunca", async () => {
    await h.send("hola"); // ventana abierta
    await h.t.db.update(schema.tenant).set({
      status: "trial",
      createdAt: new Date(Date.now() - 11 * 86_400_000),
      surveySentAt: null,
      valueSentAt: null,
    });
    await h.t.db
      .update(schema.phoneNumber)
      .set({ unsolicitedOffAt: new Date() })
      .where(eq(schema.phoneNumber.e164, OWNER));
    const meta = h.deps().metaFor("x");
    const before = h.sent.length;
    const r = await sendLifecycleNotices(h.t.db, meta, { now: new Date() });
    expect(r).toMatchObject({ survey: 0, value: 0, trialEnd: 0 });
    expect(h.sent.length).toBe(before);
    const [t] = await h.t.db.select().from(schema.tenant).where(eq(schema.tenant.id, h.tenantId));
    expect(t?.surveySentAt).not.toBeNull();
    // Terminada la prueba, el aviso de fin queda saltado aunque después vuelva a encender.
    await h.t.db.update(schema.tenant).set({ trialEndsAt: new Date(Date.now() - 60_000) });
    await sendLifecycleNotices(h.t.db, meta, { now: new Date() });
    await h.t.db.update(schema.phoneNumber).set({ unsolicitedOffAt: null });
    await sendLifecycleNotices(h.t.db, meta, { now: new Date() });
    expect(h.sent.length).toBe(before);
  });

  it("cada id de consentimiento tiene versión en el registro", () => {
    for (const id of ["H13", "H13b", "H13c", "H13c-all", "H45", "H45-n", "H46", "R-2d"])
      expect(consentTextVersion, id).toHaveProperty(id);
  });

  it("la puerta: ventana, horario, apagados, pendientes, cupo del día y fallas", async () => {
    const p = await phone();
    // Mediodía de Caracas (16:00 UTC) de mañana: fuera del horario nocturno, a cualquier hora real.
    const now = new Date(
      `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T16:00:00Z`,
    );
    const msg = (createdAt: Date, extra: Record<string, unknown>) =>
      withTenant(h.t.db, h.tenantId, (tx) =>
        tx.insert(schema.message).values({
          tenantId: h.tenantId,
          phoneId: p.id,
          direction: "out",
          kind: "text",
          status: "ok",
          createdAt,
          ...extra,
        }),
      );
    await msg(new Date(now.getTime() - 3_600_000), { direction: "in" }); // ventana abierta
    const base = { tenantId: h.tenantId, phoneId: p.id, tenantBlocked: false };
    const take = (kind: "reminder_a" | "reminder_b", at = now) =>
      withTenant(h.t.db, h.tenantId, (tx) => takeUnsolicitedSlot(tx, { ...base, kind, now: at }));
    expect(isQuietHours(now)).toBe(false);
    expect(await take("reminder_b")).toEqual({ allow: true });
    expect(await take("reminder_a")).toEqual({ allow: true });
    // Suspendido o sin mensajes: nada.
    expect(
      await withTenant(h.t.db, h.tenantId, (tx) =>
        takeUnsolicitedSlot(tx, { ...base, kind: "reminder_a", now, tenantBlocked: true }),
      ),
    ).toEqual({ allow: false, reason: "tenant_blocked" });
    // «no me recuerdes» pendiente: frena el aviso adelantado, no el recordatorio a su hora.
    await h.t.db
      .update(schema.phoneNumber)
      .set({ prefPending: "nudges_off" })
      .where(eq(schema.phoneNumber.id, p.id));
    expect(await take("reminder_b")).toMatchObject({ allow: false });
    expect(await take("reminder_a")).toEqual({ allow: true });
    // «no me escribas» pendiente: frena también el recordatorio a su hora.
    await h.t.db
      .update(schema.phoneNumber)
      .set({ prefPending: "all_off" })
      .where(eq(schema.phoneNumber.id, p.id));
    expect(await take("reminder_a")).toEqual({ allow: false, reason: "pending_opt_out" });
    await h.t.db
      .update(schema.phoneNumber)
      .set({ prefPending: null })
      .where(eq(schema.phoneNumber.id, p.id));
    // Un aviso de la prueba hoy ocupa el cupo del día para el aviso adelantado.
    await msg(now, { toolCalls: [{ name: "lifecycle_survey", args: {} }] });
    expect(await take("reminder_b")).toEqual({ allow: false, reason: "slot_taken" });
    expect(await take("reminder_a")).toEqual({ allow: true });
    // Horario nocturno: frena el adelantado, no el pedido a su hora.
    const late = new Date(now.getTime() + 9 * 3_600_000); // 21:00 de Caracas
    expect(await take("reminder_b", late)).toMatchObject({ allow: false });
    // Máximo 3 recordatorios a su hora al día.
    for (let i = 0; i < 3; i++) await msg(now, { toolCalls: [{ name: "reminder_a", args: {} }] });
    expect(await take("reminder_a")).toEqual({ allow: false, reason: "daily_cap" });
    // Un envío fallido en los últimos 7 días: nada por 7 días.
    await withTenant(h.t.db, h.tenantId, (tx) =>
      tx.delete(schema.message).where(eq(schema.message.direction, "out")),
    );
    expect(await take("reminder_a")).toEqual({ allow: true });
    await msg(now, { status: "failed" });
    expect(await take("reminder_a")).toEqual({ allow: false, reason: "failed_recent" });
  });
});

describe("interruptores de Ajustes (US-205)", () => {
  let h: Awaited<ReturnType<typeof botHarness>>;
  let phoneId: string;
  const USER = "00000000-0000-4000-8000-0000000000aa";
  const phone = async () =>
    (await h.t.db.select().from(schema.phoneNumber).where(eq(schema.phoneNumber.id, phoneId)))[0];
  const set = (which: "nudge" | "unsolicited", on: boolean) =>
    withTenant(h.t.db, h.tenantId, (tx) =>
      setDashboardPref(
        tx,
        { tenantId: h.tenantId, phoneId, userId: USER, now: new Date() },
        which,
        on,
      ),
    );
  beforeAll(async () => {
    h = await botHarness();
    const [p] = await h.t.db
      .select()
      .from(schema.phoneNumber)
      .where(eq(schema.phoneNumber.e164, OWNER));
    phoneId = p?.id ?? "";
  });
  afterAll(() => h.t.close());

  it("apagar y encender con el texto que vio en la auditoría (canal dashboard)", async () => {
    await h.t.db
      .update(schema.phoneNumber)
      .set({ prefPending: "all_off", prefPendingAt: new Date() })
      .where(eq(schema.phoneNumber.id, phoneId));
    expect(await set("unsolicited", false)).toBeNull();
    expect((await phone())?.unsolicitedOffAt).not.toBeNull();
    expect((await phone())?.prefPending).toBeNull();
    // Con los mensajes por su cuenta apagados, el aviso de racha no se enciende (R-2 c).
    expect(await set("nudge", true)).toBe("needs_unsolicited");
    expect(await set("unsolicited", true)).toBeNull();
    expect(await set("nudge", true)).toBeNull();
    expect(await phone()).toMatchObject({ unsolicitedOffAt: null, nudgeOffAt: null });
    expect((await phone())?.nudgeOptInAt).not.toBeNull();
    expect(await set("nudge", false)).toBeNull();
    expect((await phone())?.nudgeOffAt).not.toBeNull();
    const rows = await h.t.db
      .select({
        action: schema.auditLog.action,
        after: schema.auditLog.after,
        channel: schema.auditLog.channel,
      })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entity, "phone_number"));
    expect(
      rows.map((r) => [r.action, (r.after as { text_id: string }).text_id, r.channel]),
    ).toEqual([
      ["all_off", "H14e-2", "dashboard"],
      ["all_on", "H14-2", "dashboard"],
      ["nudge_opt_in", "H14-1", "dashboard"],
      ["nudge_off", "H14e-1", "dashboard"],
    ]);
  });

  it("con la etiqueta no-contactar no cambia nada", async () => {
    await h.t.db.update(schema.tenant).set({ crmTags: ["no-contactar"] });
    expect(await set("unsolicited", true)).toBe("tagged");
    await h.t.db.update(schema.tenant).set({ crmTags: [] });
  });
});
