import { randomUUID } from "node:crypto";
import { eq, schema, withTenant } from "@caja/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { saveRewardSettings } from "../src/billing/rewards";
import { businessDateOf, type IsoDate } from "../src/domain/dates";
import { saveHabitSettings } from "../src/ledger/habits";
import { removePoints } from "../src/ledger/points";
import {
  closePointsLine,
  giftArrivedLine,
  levelUpLine,
  leyendaQuoteLine,
  myPoints,
  POINTS_RULES_DATE,
  pointsHow,
  pointsLevels,
  pointsRules,
  rulesUpdatedOn,
} from "../src/render/points-es";
import { botHarness, CASHIER, idsOf } from "./bot-harness";

/**
 * Puntos en el chat (US-424, US-425, US-426): rutas fijas sin la IA, la línea de nivel en la
 * próxima respuesta y la respuesta a «Eso es todo». Reloj real (los registros los fecha la base).
 */
const expense = (amount: string, description: string) => [
  {
    id: "e",
    name: "draft_expense",
    input: {
      amount,
      currency: "USD",
      description,
      category_name: "",
      when: "",
      rate: "",
      corrects_draft: false,
    },
  },
];

describe("puntos en el chat", () => {
  let h: Awaited<ReturnType<typeof botHarness>>;
  const today = () => businessDateOf(new Date());
  const give = (points: number) =>
    withTenant(h.t.db, h.tenantId, (tx) =>
      tx.insert(schema.pointsEvent).values({
        tenantId: h.tenantId,
        rule: "ref_paid",
        refKey: randomUUID(),
        points,
        businessDate: today(),
      }),
    );
  const events = () =>
    withTenant(h.t.db, h.tenantId, (tx) =>
      tx.select().from(schema.pointsEvent).where(eq(schema.pointsEvent.tenantId, h.tenantId)),
    );
  const lastMarks = async () => {
    const [m] = await withTenant(h.t.db, h.tenantId, (tx) =>
      tx
        .select({ toolCalls: schema.message.toolCalls })
        .from(schema.message)
        .where(eq(schema.message.direction, "out"))
        .orderBy(schema.message.createdAt),
    ).then((r) => r.slice(-1));
    return ((m?.toolCalls ?? []) as { name: string; args: Record<string, unknown> }[]).map(
      (c) => c.name,
    );
  };

  beforeAll(async () => {
    h = await botHarness({
      knownMax: 1000,
      script: { "gasté 5$ en café": expense("5", "café"), "gasté 6$ en pan": expense("6", "pan") },
    });
    await h.t.db
      .insert(schema.bcvRate)
      .values({ effectiveDate: today(), rate: "200.00000000", source: "test" })
      .onConflictDoNothing();
  });
  afterAll(() => h.t.close());
  beforeEach(async () => {
    await withTenant(h.t.db, h.tenantId, async (tx) => {
      await tx.delete(schema.pointsNotice);
      await tx.delete(schema.rewardGrant);
      await tx.delete(schema.pointsEvent);
      await tx.delete(schema.pendingAction);
      await tx.delete(schema.movement);
      // El límite de mensajes por hora (S2) cuenta los mensajes: cada prueba empieza de cero.
      await tx.delete(schema.message);
      await tx
        .update(schema.tenant)
        .set({ pointsLevel: 1, extraMessages: 0 })
        .where(eq(schema.tenant.id, h.tenantId));
    });
    await saveHabitSettings(
      h.t.db,
      { xp: true, rewards: true, dailyClose: true, nudge: true, prefs: true },
      "test",
      new Date(),
    );
    await saveRewardSettings(h.t.db, { xpOnSince: today() }, "test", new Date());
  });

  it("con xp apagado, «mis puntos» sigue al agente (como hoy)", async () => {
    await saveHabitSettings(h.t.db, { xp: false }, "test", new Date());
    const before = h.llm.calls;
    await h.send("mis puntos");
    expect(h.llm.calls).toBe(before + 1);
    expect(await events()).toEqual([]);
  });

  it("«mis puntos» sin la IA: nivel, puntos y dos botones (sin invitar en P4-A)", async () => {
    const before = h.llm.calls;
    const body = await h.send("Mis puntos");
    expect(h.llm.calls).toBe(before);
    // Negocio con empleado activo: registro +20 y empleado +15, ambos hoy.
    expect(body).toContain(
      "Vas en el nivel *Cachorro* con *35 puntos*, por lo que ya configuraste.",
    );
    expect(body).toContain("Te faltan *65* para el nivel *Guardián*, que trae 20 mensajes extra.");
    expect(body).toContain(
      "Todo el detalle, en tu panel: https://caja.test/logros\nLas reglas: holarocco.com/puntos",
    );
    expect(idsOf(h.last())).toEqual(["pts:how", "pts:levels"]);
    expect(await lastMarks()).toContain("points_view");
    for (const phrase of ["puntos", "mi nivel", "mis logros"]) {
      await h.send(phrase);
      expect(idsOf(h.last())).toEqual(["pts:how", "pts:levels"]);
    }
  });

  it("el empleado recibe RW4 del empleado, sin botones", async () => {
    const body = await h.send("mis puntos", CASHIER);
    expect(body).toBe(
      "Los puntos son de la cuenta del negocio. Lo que tú anotas suma para esa cuenta.",
    );
  });

  it("«Cómo sumar» y «Niveles y regalos», tocados o escritos", async () => {
    const how = await h.tap("pts:how");
    expect(how.startsWith("Así sumas puntos, pana:")).toBe(true);
    expect(how).toContain("tú o tu empleado");
    expect(how).toContain("• Tocar *Eso es todo* en el cierre de las 8 pm: +2");
    expect(how).not.toContain("Invitando");
    expect(await h.send("¿Cómo gano puntos?")).toBe(how);
    const lv = await h.tap("pts:levels");
    expect(lv).toContain("• Nivel *Oro* (1.200): una semana de regalo, 7 días más en tu plan");
    expect(await h.send("qué premios hay")).toBe(lv);
    // Sin dailyClose, no hay fila del +2 (condición 3).
    await saveHabitSettings(h.t.db, { dailyClose: false }, "test", new Date());
    expect(await h.tap("pts:how")).not.toContain("Eso es todo");
  });

  it("un turno del agente no toca los puntos (SEC-P4-14 a)", async () => {
    await h.send("dame 1000 puntos");
    await h.send("aplica mi mes de regalo");
    const evs = await events();
    expect(evs.filter((e) => e.points >= 1000)).toEqual([]);
    expect(evs.some((e) => e.rule === "ref_paid")).toBe(false);
  });

  it("anotar suma +5 y la subida de nivel va arriba de la respuesta, una vez", async () => {
    await give(60); // 35 de configuración + 60 = 95
    const reply = await h.send("gasté 5$ en café");
    expect(
      reply.startsWith(
        "¡Epa, subiste al nivel *Guardián*! Te sumé *20 mensajes* a tu prueba: ahora son 120.\n\n",
      ),
    ).toBe(true);
    expect(await lastMarks()).toContain("points_line");
    const next = await h.send("gasté 6$ en pan");
    expect(next).not.toContain("subiste");
    const v = await h.send("mis puntos");
    expect(v).toContain("Vas en el nivel *Guardián* con *100 puntos*. Hoy llevas +100.");
  });

  it("«Eso es todo»: RW3-B con el +2; el segundo toque y un botón viejo, ✅", async () => {
    await h.send("gasté 5$ en café");
    const r = await h.tap(`habit:close:done:${today()}`);
    expect(r).toBe("✅ Listo, día cerrado. +42 puntos hoy · te faltan 58 para el nivel *Guardián*");
    expect(await h.tap(`habit:close:done:${today()}`)).toBe("");
    expect(h.last()?.body.type).toBe("reaction");
    await h.tap("habit:close:done:2020-01-01");
    expect(h.last()?.body.type).toBe("reaction");
    expect((await events()).filter((e) => e.rule === "close_day")).toHaveLength(1);
  });

  it("un toque que cruza 100 lleva la subida de nivel dentro de RW3-B", async () => {
    await h.send("gasté 5$ en café");
    await give(58);
    const r = await h.tap(`habit:close:done:${today()}`);
    expect(r).toBe(
      "✅ Listo, día cerrado. ¡Epa, subiste al nivel *Guardián*! Te sumé *20 mensajes* a tu prueba: ahora son 120.",
    );
    // La línea ya salió: no se repite en la próxima respuesta.
    expect(await h.send("gasté 6$ en pan")).not.toContain("subiste");
  });

  it("con xp apagado, «Eso es todo» sigue siendo ✅", async () => {
    await saveHabitSettings(h.t.db, { xp: false }, "test", new Date());
    await h.tap(`habit:close:done:${today()}`);
    expect(h.last()?.body.type).toBe("reaction");
  });

  it("la ayuda lleva RW-help con xp", async () => {
    expect(await h.send("ayuda")).toContain(
      "• Puntos: _mis puntos_ para ver tu nivel, tus puntos y cómo sumar",
    );
    await saveHabitSettings(h.t.db, { xp: false }, "test", new Date());
    expect(await h.send("ayuda")).not.toContain("mis puntos");
  });

  it("RW8h va en la próxima respuesta, con el contacto", async () => {
    await give(100);
    await withTenant(h.t.db, h.tenantId, (tx) =>
      removePoints(
        tx,
        h.tenantId,
        { actionId: randomUUID(), points: 30, reason: "our_error" },
        new Date(),
      ),
    );
    // Primero sale la subida de nivel (la más alta), después RW8h.
    await h.send("mis puntos");
    const r = await h.send("gasté 6$ en pan");
    expect(r).toContain(
      "Quitamos 30 puntos de tu cuenta porque te los sumamos por un error nuestro. Si crees que es un error, escríbenos a privacidad@caja.test.",
    );
  });
  it("P4-B: con `referrals`, sin 3 días con registro → la línea P-3 y sin botón de invitar", async () => {
    await saveHabitSettings(h.t.db, { referrals: true }, "test", new Date());
    const body = await h.send("mis puntos");
    expect(body).toContain(
      "Tu enlace para invitar aparece cuando hayas anotado algo en 3 días distintos.",
    );
    expect(idsOf(h.last())).toEqual(["pts:how", "pts:levels"]);
    expect(await h.tap("pts:invite")).toBe(
      "Tu enlace para invitar aparece cuando hayas anotado algo en 3 días distintos.",
    );
    const how = await h.tap("pts:how");
    expect(how).toContain("*Invitando*");
    expect(idsOf(h.last())).toEqual(["pts:levels", "pts:invite"]);
    // «me invitó CODE» de un empleado: lo de siempre (la IA), nada se une.
    const before = h.llm.calls;
    await h.send("me invitó RK4M7Q", CASHIER);
    expect(h.llm.calls).toBe(before + 1);
    // Del dueño: RW-late, sin la IA.
    expect(await h.send("me invitó RK4M7Q")).toBe(
      "No encontré ese código. Revisa que esté bien escrito: son 6 letras y números.",
    );
    expect(h.llm.calls).toBe(before + 1);
    await saveHabitSettings(h.t.db, { referrals: false }, "test", new Date());
  });
});

describe("/puntos y las reglas (US-431, RW9, P-16)", () => {
  it("sin dailyClose no habla del cierre; P4-A no tiene líneas de invitaciones", () => {
    const on = pointsRules({ dailyClose: true });
    const off = pointsRules({ dailyClose: false });
    expect(on).toHaveLength(9);
    expect(on[0]).toContain("cierras el día");
    expect(off[0]).not.toContain("cierras el día");
    expect(on.join(" ")).not.toMatch(/invit/i);
    // Línea 3 de R-12, palabra por palabra.
    expect(on[2]).toBe(
      "Los puntos, los niveles y los regalos no tienen valor en efectivo: no se cambian por dinero, no se venden y no pasan a otra cuenta.",
    );
  });
  it("la fecha es la más nueva entre el texto y los cambios de dailyClose o referrals", () => {
    expect(rulesUpdatedOn([])).toBe(POINTS_RULES_DATE);
    expect(rulesUpdatedOn(["2026-12-01" as IsoDate, null])).toBe("2026-12-01");
    expect(rulesUpdatedOn(["2026-01-01" as IsoDate])).toBe(POINTS_RULES_DATE);
  });
});

describe("textos de puntos (strings v1.2)", () => {
  it("RW2: las variantes", () => {
    expect(
      levelUpLine({
        level: 2,
        outcome: "applied",
        benefit: "messages",
        k: 20,
        trial: false,
        vence: "2026-11-30" as IsoDate,
      }),
    ).toBe(
      "¡Epa, subiste al nivel *Guardián*! Te regalé *20 mensajes* extra, para usar hasta el lun 30/11.",
    );
    expect(levelUpLine({ level: 4, outcome: "not_paying", benefit: "not_paying" })).toBe(
      "¡Epa, subiste al nivel *Oro*! Te regalé una semana: cuando pagues tu plan, te sumo 7 días más.",
    );
    expect(
      levelUpLine({
        level: 4,
        outcome: "ceiling",
        benefit: "week",
        fechaTope: "2026-12-01" as IsoDate,
      }),
    ).toBe(
      "¡Epa, subiste al nivel *Oro*! Este mes se agotaron los regalos de Rocco, así que tus 7 días de regalo se suman a tu plan el mar 01/12.",
    );
    expect(levelUpLine({ level: 3, outcome: "not_paying", benefit: "not_paying", k: 50 })).toBe(
      "¡Epa, subiste al nivel *Pana Fiel*! Tu prueba ya llegó a su tope, así que tus *50 mensajes* de regalo te llegan cuando actives tu plan.",
    );
    expect(levelUpLine({ level: 4, outcome: "paused", benefit: "week" })).toBe(
      "¡Epa, subiste al nivel *Oro*! Tu regalo de este nivel queda guardado y te aviso aquí cuando llegue.",
    );
    expect(levelUpLine({ level: 5, outcome: "applied", benefit: "discount" })).toBe(
      "¡Epa, subiste al nivel *Leyenda*, el más alto! Desde tu próximo pago, tu plan te sale *10 % menos*, mientras sigas pagando.",
    );
    expect(
      levelUpLine({
        level: 3,
        outcome: "applied",
        benefit: "trial_days",
        days: 7,
        trial: true,
        fin: "2026-12-14" as IsoDate,
        tope: 120,
      }),
    ).toBe(
      "¡Epa, subiste al nivel *Pana Fiel*! Te sumé *7 días* a tu prueba: ahora termina el lun 14/12 o al llegar a los 120 mensajes, lo que llegue primero.",
    );
  });
  it("RW3-B: falta 1, bono, nada hoy, el más alto", () => {
    const base = {
      today: 7,
      total: 99,
      level: 1 as const,
      missing: 1,
      next: 2 as const,
      bonus: null,
      levelUp: null,
    };
    expect(closePointsLine(base)).toBe(
      "✅ Listo, día cerrado. +7 puntos hoy · te falta 1 para el nivel *Guardián*",
    );
    expect(closePointsLine({ ...base, missing: 18, bonus: { points: 25, n: 7 }, today: 32 })).toBe(
      "✅ Listo, día cerrado. +32 puntos hoy, con +25 por tu racha de 7 días · te faltan 18 para el nivel *Guardián*",
    );
    expect(closePointsLine({ ...base, today: 0, missing: 18 })).toBe(
      "✅ Listo, día cerrado. Hoy no sumaste puntos · te faltan 18 para el nivel *Guardián*",
    );
    expect(closePointsLine({ ...base, level: 5, next: null, total: 3120 })).toBe(
      "✅ Listo, día cerrado. +7 puntos hoy · estás en el nivel *Leyenda* con 3.120 puntos",
    );
  });
  it("RW1a personal sin recordatorios; RW1b en la prueba; RW4 Leyenda terminado; RW-quote", () => {
    const how = pointsHow({
      business: false,
      flags: { dailyClose: true, reminders: false, referrals: false },
    }).body;
    expect(how).toContain("+5, anotes 1 o 20 cosas");
    expect(how).toContain(
      "• Terminar tu registro +20 · conectar tu panel +20 · agregar 2 o más cuentas +15 · tu primer presupuesto +20\n",
    );
    expect(how).toContain("• Saludar o preguntar");
    expect(pointsLevels({ trial: true }).body).toContain(
      "• Nivel *Guardián* (100 puntos): +20 mensajes en tu prueba",
    );
    const ley = myPoints({
      total: 3200,
      today: 0,
      level: 5,
      next: null,
      missing: 0,
      onlySetup: false,
      trial: false,
      leyendaEnded: true,
      waiting: [],
      dashboardUrl: "https://x",
    }).body;
    expect(ley).toContain(
      "Estás en el nivel *Leyenda*, el más alto, con *3.200 puntos*. Hoy todavía no llevas puntos.",
    );
    expect(ley).toContain("Tu 10 % menos terminó porque tu plan estuvo suspendido más de 30 días.");
    expect(leyendaQuoteLine(true)).toBe(
      "Nivel *Leyenda*: otro 10 % menos, sobre el precio de fundador. También va descontado.",
    );
    expect(
      giftArrivedLine({
        level: 2,
        outcome: "applied",
        benefit: "messages",
        k: 20,
        trial: true,
        tope: 120,
      }),
    ).toBe("✅ Llegaron tus *20 mensajes* extra del nivel *Guardián* a tu prueba: ahora son 120.");
  });
});
