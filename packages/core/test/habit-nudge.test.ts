import { eq, rows, schema, sql, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, businessDateOf } from "../src/domain/dates";
import { takeUnsolicitedSlot } from "../src/inbox/gate";
import { inNudgeWindow, runHabitNudges } from "../src/inbox/nudge";
import { saveHabitSettings } from "../src/ledger/habits";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/** El aviso de las 8 pm (PRD hábitos US-207) y su pausa (US-208), con el reloj fijo. */
const OWNER = "584121234567";
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Hoy a las hh:mm de Caracas. */
const at = (hh: number, mm: number, dayOffset = 0) => {
  const d = addDays(businessDateOf(new Date()), dayOffset);
  return new Date(`${d}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00-04:00`);
};

describe("inNudgeWindow", () => {
  it("de 20:00 a 20:29 de Caracas", () => {
    expect(inNudgeWindow(at(19, 59))).toBe(false);
    expect(inNudgeWindow(at(20, 0))).toBe(true);
    expect(inNudgeWindow(at(20, 29))).toBe(true);
    expect(inNudgeWindow(at(20, 30))).toBe(false);
  });
});

describe("runHabitNudges (US-207, US-208)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId = "";
  let phoneId = "";
  const sent: Record<string, unknown>[] = [];
  let failNext = false;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (failNext) {
      failNext = false;
      return new Response(
        JSON.stringify({ error: { code: 131047, message: "Re-engagement message" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    sent.push(body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT.${Math.random()}` }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const meta = new MetaClient({ accessToken: "T", phoneNumberId: fx.PHONE_NUMBER_ID, fetchImpl });
  const now = at(20, 5);

  /** Un registro creado `daysAgo` días antes de `now`. */
  const record = (daysAgo: number) =>
    withTenant(t.db, tenantId, (tx) => {
      const created = new Date(now.getTime() - daysAgo * DAY - HOUR);
      return tx.insert(schema.movement).values({
        tenantId,
        type: "expense",
        amount: "1.00",
        currency: "USD",
        amountUsd: "1.00",
        amountVes: "200.00",
        rateValue: "200.00000000",
        rateSource: "manual",
        businessDate: businessDateOf(created),
        paymentMethod: "unspecified",
        origin: "single",
        sourceChannel: "text",
        createdByPhoneId: phoneId,
        createdAt: created,
      });
    });
  /** El dueño escribió hace `hoursAgo` horas (abre la ventana de 24 h). */
  const wrote = (hoursAgo: number) =>
    withTenant(t.db, tenantId, (tx) =>
      tx.insert(schema.message).values({
        tenantId,
        phoneId,
        direction: "in",
        kind: "text",
        body: "x",
        createdAt: new Date(now.getTime() - hoursAgo * HOUR),
      }),
    );
  /** Un aviso ya enviado `daysAgo` días antes, a las 20:00. */
  const pastNudge = (daysAgo: number) =>
    withTenant(t.db, tenantId, (tx) =>
      tx.insert(schema.message).values({
        tenantId,
        phoneId,
        direction: "out",
        kind: "buttons",
        body: "x",
        status: "ok",
        createdAt: new Date(at(20, 0).getTime() - daysAgo * DAY),
        toolCalls: [{ name: "habit_nudge", args: { n: 2 } }],
      }),
    );
  const nudgeRows = () =>
    withTenant(t.db, tenantId, async (tx) =>
      (await tx.select().from(schema.message)).filter((m) =>
        JSON.stringify(m.toolCalls ?? []).includes("habit_nudge"),
      ),
    );
  const bodyOf = (b: Record<string, unknown> | undefined) =>
    (b?.interactive as { body?: { text?: string } } | undefined)?.body?.text;
  const idsOf = (b: Record<string, unknown> | undefined) =>
    (
      b?.interactive as { action?: { buttons?: { reply: { id: string } }[] } } | undefined
    )?.action?.buttons?.map((x) => x.reply.id);

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, { name: "Ana", businessType: "personal", ownerPhone: OWNER });
    const [p] = await t.db.select().from(schema.phoneNumber);
    phoneId = p?.id ?? "";
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    sent.length = 0;
    failNext = false;
    await withTenant(t.db, tenantId, async (tx) => {
      await tx.delete(schema.movement);
      await tx.delete(schema.noSpendDay);
      await tx.delete(schema.message);
      await tx
        .update(schema.tenant)
        .set({
          businessType: "personal",
          status: "trial",
          createdAt: new Date(now.getTime() - DAY),
          trialEndsAt: new Date(now.getTime() + 30 * DAY),
          surveySentAt: null,
          valueSentAt: null,
        })
        .where(eq(schema.tenant.id, tenantId));
    });
    await t.db.delete(schema.auditLog);
    await t.db.update(schema.phoneNumber).set({
      nudgeOptInAt: new Date(now.getTime() - 30 * DAY),
      nudgeOffAt: null,
      unsolicitedOffAt: null,
      nudgePausedUntil: null,
      prefPending: null,
    });
    await saveHabitSettings(
      t.db,
      { prefs: true, nudge: true, noSpend: true, streakLine: true, dailyClose: false },
      "test",
      now,
    );
  });

  it("racha de 2 sin nada hoy y la ventana abierta → H9 con los dos botones y la marca en ok", async () => {
    await record(2);
    await record(1);
    await wrote(3);
    const r = await runHabitNudges(t.db, meta, { now });
    expect(r).toMatchObject({ sent: 1, failed: 0 });
    expect(bodyOf(sent[0])).toBe("¿Hubo algo hoy que anotar? Así sigue tu racha de 2 días 🔥");
    expect(idsOf(sent[0])).toEqual([`habit:nospend:${businessDateOf(now)}`, "pref:nudges_off"]);
    const rows = await nudgeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("ok");
    expect(rows[0]?.toolCalls).toEqual([{ name: "habit_nudge", args: { n: 2 } }]);
  });

  it("dos corridas el mismo día y un reintento a las 20:25 mandan uno; a las 20:31, ninguno", async () => {
    await record(2);
    await record(1);
    await wrote(3);
    await runHabitNudges(t.db, meta, { now });
    await runHabitNudges(t.db, meta, { now });
    const retry = await runHabitNudges(t.db, meta, { now: at(20, 25) });
    expect(retry.skipped.slot_taken).toBe(1);
    expect(sent).toHaveLength(1);
    await t.db.delete(schema.message).where(eq(schema.message.direction, "out"));
    const late = await runHabitNudges(t.db, meta, { now: at(20, 31) });
    expect(late.outside).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("negocio: H9 de negocio y «Hoy no hubo nada»; víspera de los 7 días", async () => {
    await withTenant(t.db, tenantId, (tx) =>
      tx.update(schema.tenant).set({ businessType: "food" }).where(eq(schema.tenant.id, tenantId)),
    );
    for (const d of [6, 5, 4, 3, 2, 1]) await record(d);
    await wrote(3);
    await runHabitNudges(t.db, meta, { now });
    expect(bodyOf(sent[0])).toBe("¿Hubo ventas o gastos hoy? Así llegas a 7 días seguidos 🔥");
    const i = sent[0]?.interactive as { action: { buttons: { reply: { title: string } }[] } };
    expect(i.action.buttons[0]?.reply.title).toBe("Hoy no hubo nada");
  });

  it("sin el interruptor sin gastos, solo «No me recuerdes»", async () => {
    await saveHabitSettings(t.db, { noSpend: false }, "test", now);
    await record(2);
    await record(1);
    await wrote(3);
    await runHabitNudges(t.db, meta, { now });
    expect(idsOf(sent[0])).toEqual(["pref:nudges_off"]);
  });

  it("no sale: interruptor apagado, sin aceptar, ya anotó hoy, racha de 1, ventana cerrada, apagado", async () => {
    await record(2);
    await record(1);
    await wrote(3);
    await saveHabitSettings(t.db, { nudge: false }, "test", now);
    await runHabitNudges(t.db, meta, { now });
    await saveHabitSettings(t.db, { nudge: true }, "test", now);
    await t.db.update(schema.phoneNumber).set({ nudgeOptInAt: null });
    expect((await runHabitNudges(t.db, meta, { now })).skipped.not_opted_in).toBe(1);
    await t.db.update(schema.phoneNumber).set({ nudgeOptInAt: new Date(now.getTime() - DAY) });
    await record(0);
    expect((await runHabitNudges(t.db, meta, { now })).skipped.kept_today).toBe(1);
    await withTenant(t.db, tenantId, (tx) => tx.delete(schema.movement));
    await record(1);
    expect((await runHabitNudges(t.db, meta, { now })).skipped.short_streak).toBe(1);
    await record(2);
    await t.db.delete(schema.message);
    await wrote(25);
    expect((await runHabitNudges(t.db, meta, { now })).skipped.window_closed).toBe(1);
    await wrote(2);
    await t.db.update(schema.phoneNumber).set({ unsolicitedOffAt: now });
    expect((await runHabitNudges(t.db, meta, { now })).skipped.opted_out).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it("Meta lo rechaza → la fila queda en failed y no se reintenta", async () => {
    await record(2);
    await record(1);
    await wrote(3);
    failNext = true;
    const r = await runHabitNudges(t.db, meta, { now });
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect((await nudgeRows())[0]?.status).toBe("failed");
    expect((await runHabitNudges(t.db, meta, { now: at(20, 10) })).sent).toBe(0);
  });

  it("US-208: 3 avisos seguidos sin cumplir → pausa de 14 días, en silencio, con auditoría", async () => {
    for (const d of [5, 4]) await record(d);
    await pastNudge(3);
    await pastNudge(2);
    await pastNudge(1);
    await record(6);
    await wrote(3);
    const r = await runHabitNudges(t.db, meta, { now });
    expect(r).toMatchObject({ sent: 0, paused: 1 });
    expect(sent).toHaveLength(0);
    const [p] = await t.db.select().from(schema.phoneNumber);
    expect(p?.nudgePausedUntil?.getTime()).toBe(now.getTime() + 14 * DAY);
    const audits = await t.db.select().from(schema.auditLog);
    expect(audits.map((a) => a.action)).toEqual(["nudge_auto_pause"]);
    // En pausa: la puerta lo niega.
    expect((await runHabitNudges(t.db, meta, { now: at(20, 6) })).skipped.paused).toBe(1);
  });

  it("US-208: 2 ignorados y 1 cumplido → sin pausa; los de antes de aceptar no cuentan", async () => {
    await pastNudge(3);
    await pastNudge(2);
    await pastNudge(1);
    await record(2);
    await record(1);
    await wrote(3);
    const r = await runHabitNudges(t.db, meta, { now });
    expect(r).toMatchObject({ sent: 1, paused: 0 });
    // Los 3 sin cumplir, pero de antes de la última aceptación: tampoco pausan.
    await t.db.delete(schema.message);
    await withTenant(t.db, tenantId, (tx) => tx.delete(schema.movement));
    for (const d of [6, 5, 4]) await pastNudge(d);
    await record(2);
    await record(1);
    await wrote(3);
    await t.db
      .update(schema.phoneNumber)
      .set({ nudgeOptInAt: new Date(now.getTime() - 3 * DAY - 2 * HOUR) });
    expect((await runHabitNudges(t.db, meta, { now })).paused).toBe(0);
  });

  const setTenant = (set: Partial<typeof schema.tenant.$inferInsert>) =>
    withTenant(t.db, tenantId, (tx) =>
      tx.update(schema.tenant).set(set).where(eq(schema.tenant.id, tenantId)),
    );

  it("F-1: la prueba termina hoy a las 21:00 → sin aviso a las 20:00 (lifecycle_today)", async () => {
    await record(2);
    await record(1);
    await wrote(3);
    await setTenant({ trialEndsAt: at(21, 0) });
    expect((await runHabitNudges(t.db, meta, { now })).skipped.lifecycle_today).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it("F-1: el día de la encuesta empieza a las 22:00 → sin aviso", async () => {
    await record(2);
    await record(1);
    await wrote(3);
    await setTenant({ createdAt: new Date(at(22, 0).getTime() - 10 * DAY) });
    expect((await runHabitNudges(t.db, meta, { now })).skipped.lifecycle_today).toBe(1);
    // Con la encuesta ya enviada, el aviso sale.
    await setTenant({ surveySentAt: at(9, 0) });
    expect((await runHabitNudges(t.db, meta, { now })).sent).toBe(1);
  });

  it("F-1: el aviso de fin de este fin ya salió (ayer) → el aviso sale", async () => {
    await record(2);
    await record(1);
    await wrote(3);
    // Sin el aviso de fin, la prueba terminada se queda con el día.
    await setTenant({ trialEndsAt: at(18, 0, -1) });
    expect((await runHabitNudges(t.db, meta, { now })).skipped.lifecycle_today).toBe(1);
    await withTenant(t.db, tenantId, (tx) =>
      tx.insert(schema.message).values({
        tenantId,
        phoneId,
        direction: "out",
        kind: "buttons",
        body: "x",
        createdAt: at(18, 30, -1),
        toolCalls: [{ name: "lifecycle_trial_end", args: {} }],
      }),
    );
    expect((await runHabitNudges(t.db, meta, { now })).sent).toBe(1);
  });

  it("S-2: dos tomas del cupo en paralelo para un teléfono → un solo allow", async () => {
    await wrote(3);
    const take = () =>
      withTenant(t.db, tenantId, async (tx) => {
        const g = await takeUnsolicitedSlot(tx, {
          tenantId,
          phoneId,
          kind: "nudge",
          now,
          tenantBlocked: false,
        });
        if (g.allow)
          await tx.insert(schema.message).values({
            tenantId,
            phoneId,
            direction: "out",
            kind: "text",
            body: "x",
            createdAt: now,
            toolCalls: [{ name: "habit_nudge", args: { n: 2 } }],
          });
        return g.allow;
      });
    const results = await Promise.all([take(), take()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    // PGlite corre las transacciones de a una: además se comprueba que el candado se toma y dura
    // la transacción de quien llama (en Postgres, la segunda espera a que la primera confirme).
    const locks = await withTenant(t.db, tenantId, async (tx) => {
      await takeUnsolicitedSlot(tx, {
        tenantId,
        phoneId,
        kind: "nudge",
        now,
        tenantBlocked: false,
      });
      return rows<{ n: number }>(
        await tx.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory'`),
      )[0]?.n;
    });
    expect(locks).toBe(1);
  });

  /** Un movimiento de hoy (o de hace `daysAgo` días) por `usd` dólares. */
  const move = (type: "expense" | "income", usd: string, daysAgo = 0, at = now) =>
    withTenant(t.db, tenantId, (tx) => {
      const created = new Date(at.getTime() - daysAgo * DAY - HOUR);
      return tx.insert(schema.movement).values({
        tenantId,
        type,
        amount: usd,
        currency: "USD",
        amountUsd: usd,
        amountVes: "200.00",
        rateValue: "200.00000000",
        rateSource: "manual",
        businessDate: businessDateOf(created),
        paymentMethod: "unspecified",
        origin: "single",
        sourceChannel: "text",
        createdByPhoneId: phoneId,
        createdAt: created,
      });
    });
  const ASK =
    "¿Te escribo así a las 8 pm, si me escribiste en las últimas 24 horas? Lo apagas cuando quieras.";
  const optedIn = () =>
    t.db.update(schema.phoneNumber).set({ nudgeOptInAt: new Date(now.getTime() - 30 * DAY) });

  it("1B: sin aceptarlo, el primer mensaje pregunta (con lo del día); sin su «Sí», no hay otro", async () => {
    await saveHabitSettings(t.db, { dailyClose: true }, "test", now);
    await t.db.update(schema.phoneNumber).set({ nudgeOptInAt: null });
    await record(1);
    await move("expense", "2.00");
    await wrote(3);
    expect((await runHabitNudges(t.db, meta, { now })).sent).toBe(1);
    expect(bodyOf(sent[0])).toBe(
      `Hoy anotaste *$2,00* en gastos (1 registro).\n🔥 Llevas 2 días seguidos.\n¿Falta algo por anotar?\n\n${ASK}`,
    );
    expect(idsOf(sent[0])).toEqual(["pref:optin", "pref:nudges_off"]);
    const first = sent[0]?.interactive as
      | { action: { buttons: { reply: { title: string } }[] } }
      | undefined;
    const titles = first?.action.buttons.map((b) => b.reply.title);
    expect(titles).toEqual(["Sí, escríbeme", "No me recuerdes"]);
    // Mañana, sin haber tocado «Sí»: nada.
    const tomorrow = new Date(now.getTime() + DAY);
    await move("expense", "3.00", 0, tomorrow);
    await withTenant(t.db, tenantId, (tx) =>
      tx.insert(schema.message).values({
        tenantId,
        phoneId,
        direction: "in",
        kind: "text",
        body: "x",
        createdAt: new Date(tomorrow.getTime() - 2 * HOUR),
      }),
    );
    expect((await runHabitNudges(t.db, meta, { now: tomorrow })).skipped.not_opted_in).toBe(1);
    expect(sent).toHaveLength(1);
    // Con el «Sí» (la columna puesta): el cierre, sin la pregunta.
    await t.db.update(schema.phoneNumber).set({ nudgeOptInAt: new Date(now.getTime() + HOUR) });
    expect((await runHabitNudges(t.db, meta, { now: tomorrow })).sent).toBe(1);
    expect(bodyOf(sent[1])).toBe(
      "Hoy anotaste *$3,00* en gastos (1 registro).\n🔥 Llevas 3 días seguidos.\n¿Falta algo por anotar?",
    );
    expect(idsOf(sent[1])).toEqual([
      `habit:close:done:${businessDateOf(tomorrow)}`,
      `habit:close:more:${businessDateOf(tomorrow)}`,
      "pref:nudges_off",
    ]);
  });

  it("MF-1: si el primer mensaje falló, el siguiente vuelve a preguntar", async () => {
    await saveHabitSettings(t.db, { dailyClose: true }, "test", now);
    await t.db.update(schema.phoneNumber).set({ nudgeOptInAt: null });
    await wrote(3);
    failNext = true;
    expect((await runHabitNudges(t.db, meta, { now })).failed).toBe(1);
    const tomorrow = new Date(now.getTime() + DAY);
    await withTenant(t.db, tenantId, (tx) =>
      tx.insert(schema.message).values({
        tenantId,
        phoneId,
        direction: "in",
        kind: "text",
        body: "x",
        createdAt: new Date(tomorrow.getTime() - 2 * HOUR),
      }),
    );
    // El fallo bloquea 7 días (failed_recent); pasado eso, vuelve a preguntar.
    await t.db
      .update(schema.message)
      .set({ createdAt: new Date(now.getTime() - 8 * DAY) })
      .where(eq(schema.message.status, "failed"));
    expect((await runHabitNudges(t.db, meta, { now: tomorrow })).sent).toBe(1);
    expect(bodyOf(sent[0])).toMatch(new RegExp(`${ASK.replace(/[?¿]/g, ".")}$`));
  });

  it("MF-2: persona con solo ingreso; persona ingreso + gasto; negocio «se anotaron»", async () => {
    await saveHabitSettings(t.db, { dailyClose: true }, "test", now);
    await optedIn();
    await move("income", "100.00");
    await wrote(3);
    await runHabitNudges(t.db, meta, { now });
    expect(bodyOf(sent[0])).toBe(
      "Hoy anotaste *$100,00* en ingresos (1 registro).\n¿Falta algo por anotar?",
    );
    await t.db.delete(schema.message).where(eq(schema.message.direction, "out"));
    await move("expense", "1.00");
    await runHabitNudges(t.db, meta, { now });
    expect(bodyOf(sent[1])).toBe(
      "Hoy anotaste *$100,00* en ingresos y *$1,00* en gastos (2 registros).\n¿Falta algo por anotar?",
    );
    await t.db.delete(schema.message).where(eq(schema.message.direction, "out"));
    await withTenant(t.db, tenantId, (tx) =>
      tx.update(schema.tenant).set({ businessType: "food" }).where(eq(schema.tenant.id, tenantId)),
    );
    await runHabitNudges(t.db, meta, { now });
    expect(bodyOf(sent[2])).toBe(
      "Hoy se anotaron *$100,00* en ventas y *$1,00* en gastos (2 registros).\n¿Falta algo por anotar?",
    );
  });

  it("MF-2: un día con solo una transferencia no manda nada (kept_today)", async () => {
    await saveHabitSettings(t.db, { dailyClose: true }, "test", now);
    await optedIn();
    const [a, b] = await withTenant(t.db, tenantId, (tx) =>
      tx
        .insert(schema.account)
        .values([
          { tenantId, name: "A", currency: "USD", openingDate: businessDateOf(now) },
          { tenantId, name: "B", currency: "USD", openingDate: businessDateOf(now) },
        ])
        .returning({ id: schema.account.id }),
    );
    await withTenant(t.db, tenantId, (tx) =>
      tx.insert(schema.accountTransfer).values({
        tenantId,
        fromAccountId: a?.id ?? "",
        toAccountId: b?.id ?? "",
        fromAmount: "5.00",
        toAmount: "5.00",
        businessDate: businessDateOf(now),
        createdByPhoneId: phoneId,
        createdAt: new Date(now.getTime() - HOUR),
      }),
    );
    await wrote(3);
    const r = await runHabitNudges(t.db, meta, { now });
    expect(r.skipped.kept_today).toBe(1);
    expect(sent).toHaveLength(0);
    await withTenant(t.db, tenantId, async (tx) => {
      await tx.delete(schema.accountTransfer);
      await tx.delete(schema.account).where(eq(schema.account.name, "A"));
      await tx.delete(schema.account).where(eq(schema.account.name, "B"));
    });
  });

  it("8 pm para todos: «No me recuerdes», un día sin gastos o la ventana cerrada → nada", async () => {
    await saveHabitSettings(t.db, { dailyClose: true }, "test", now);
    await t.db.update(schema.phoneNumber).set({ nudgeOptInAt: null, nudgeOffAt: now });
    await record(0);
    await wrote(3);
    expect((await runHabitNudges(t.db, meta, { now })).skipped.not_opted_in).toBe(1);
    await t.db.update(schema.phoneNumber).set({ nudgeOffAt: null });
    await withTenant(t.db, tenantId, (tx) => tx.delete(schema.movement));
    await withTenant(t.db, tenantId, (tx) =>
      tx.insert(schema.noSpendDay).values({ tenantId, phoneId, day: businessDateOf(now) }),
    );
    expect((await runHabitNudges(t.db, meta, { now })).skipped.kept_today).toBe(1);
    await withTenant(t.db, tenantId, (tx) => tx.delete(schema.noSpendDay));
    await t.db.delete(schema.message);
    await wrote(25);
    expect((await runHabitNudges(t.db, meta, { now })).skipped.window_closed).toBe(1);
    expect(sent).toHaveLength(0);
  });
});
