import { randomUUID } from "node:crypto";
import { eq, rows, schema, sql, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approvePayment, recordPayment } from "../src/billing/payments";
import { planById } from "../src/billing/plans";
import { quote } from "../src/billing/pricing";
import {
  bookRewardCost,
  leyendaPct,
  parseCeiling,
  rewardChangesForFlags,
  rewardSettings,
  saveRewardSettings,
} from "../src/billing/rewards";
import { addDays, businessDateOf, type IsoDate } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";
import { habitSettings, saveHabitSettings } from "../src/ledger/habits";
import {
  awardCloseDay,
  nextNotice,
  pointsTotals,
  removePoints,
  runPointsHousekeeping,
  syncPoints,
} from "../src/ledger/points";

/**
 * Puntos, niveles y regalos (PRD hábitos v4.2.1, fase 4: US-411, US-413…US-417, US-432). Reloj
 * fijo: el mediodía de Caracas del 24/11/2026; los registros se crean con su `created_at`.
 */
const DAY = 86_400_000;
const NOW = new Date("2026-11-24T16:00:00Z");
const TODAY = businessDateOf(NOW);
const reviewer = { userId: randomUUID(), email: "admin@ejemplo.com" };

describe("puntos (P4-A)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let n = 0;

  beforeAll(async () => {
    t = await createTestDb();
    await t.db.insert(schema.userAccount).values({ id: reviewer.userId, email: reviewer.email });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await saveHabitSettings(t.db, { xp: true, rewards: true, dailyClose: true }, "test", NOW);
    await t.db.delete(schema.appSetting).where(eq(schema.appSetting.key, "rewards"));
    await t.db.delete(schema.rewardMonth);
    await saveRewardSettings(t.db, { xpOnSince: addDays(TODAY, -60) }, "test", NOW);
  });

  async function tenant(opts: Partial<typeof schema.tenant.$inferInsert> = {}) {
    const id = await seedTenant(t.db, {
      name: "Ana",
      businessType: "retail",
      ownerPhone: `58412${String(1_000_000 + ++n)}`,
    });
    await withTenant(t.db, id, (tx) =>
      tx
        .update(schema.tenant)
        .set({ createdAt: new Date(NOW.getTime() - 90 * DAY), ...opts })
        .where(eq(schema.tenant.id, id)),
    );
    const owner = await withTenant(t.db, id, async (tx) => {
      const [p] = await tx.select().from(schema.phoneNumber);
      return p?.id ?? "";
    });
    return { id, owner };
  }
  /** Un gasto creado en ese instante (la racha y los puntos miran cuándo se creó). */
  const record = (
    tn: { id: string; owner: string },
    at: Date,
    opts: { deletedAt?: Date; phoneId?: string } = {},
  ) =>
    withTenant(t.db, tn.id, (tx) =>
      tx.insert(schema.movement).values({
        tenantId: tn.id,
        type: "expense",
        amount: "1.00",
        currency: "USD",
        amountUsd: "1.00",
        amountVes: "200.00",
        rateValue: "200.00000000",
        rateSource: "manual",
        businessDate: businessDateOf(at),
        paymentMethod: "unspecified",
        origin: "single",
        sourceChannel: "text",
        createdByPhoneId: opts.phoneId ?? tn.owner,
        createdAt: at,
        ...(opts.deletedAt ? { deletedAt: opts.deletedAt } : {}),
      }),
    );
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);
  const noSpend = (tn: { id: string; owner: string }, d: number) =>
    withTenant(t.db, tn.id, (tx) =>
      tx
        .insert(schema.noSpendDay)
        .values({ tenantId: tn.id, phoneId: tn.owner, day: businessDateOf(daysAgo(d)) }),
    );
  const sync = (id: string, now = NOW) => withTenant(t.db, id, (tx) => syncPoints(tx, id, now));
  const events = (id: string) =>
    withTenant(t.db, id, (tx) =>
      tx.select().from(schema.pointsEvent).where(eq(schema.pointsEvent.tenantId, id)),
    );
  const sumRule = async (id: string, rule: string) =>
    (await events(id)).filter((e) => e.rule === rule).reduce((a, e) => a + e.points, 0);
  const grants = (id: string) =>
    withTenant(t.db, id, (tx) =>
      tx.select().from(schema.rewardGrant).where(eq(schema.rewardGrant.tenantId, id)),
    );
  const tenantRow = async (id: string) =>
    (
      await withTenant(t.db, id, (tx) =>
        tx.select().from(schema.tenant).where(eq(schema.tenant.id, id)),
      )
    )[0] as typeof schema.tenant.$inferSelect;
  /** Puntos a mano en el libro, para llevar el total a un número. */
  const give = (id: string, points: number, key = randomUUID()) =>
    withTenant(t.db, id, (tx) =>
      tx
        .insert(schema.pointsEvent)
        .values({ tenantId: id, rule: "ref_paid", refKey: key, points, businessDate: TODAY }),
    );

  // ------------------------------------------------------------ US-411: contador y función

  describe("app.book_reward_cost (US-411, SEC-P4-1, SEC-P4-5, SEC-P4-9)", () => {
    const book = (month: string, usd: string, force = false) =>
      t.db.transaction((tx) => bookRewardCost(tx, month, new Decimal(usd), force));
    it("el primer regalo de un mes nuevo reserva (crea la fila del mes)", async () => {
      expect(await book("2026-11", "1.05")).toBe(true);
      const [r] = await t.db.select().from(schema.rewardMonth);
      expect(r?.bookedUsd).toBe("1.05");
    });
    it("con $18.50 reservados y tope $20, de dos de $1.05 solo una reserva", async () => {
      await book("2026-11", "18.50");
      const results = await Promise.all([book("2026-11", "1.05"), book("2026-11", "1.05")]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });
    it("el tope se lee de app_setting: con $1 no cabe $1.05; p_force reserva igual", async () => {
      await saveRewardSettings(t.db, { monthlyCeilingUsd: 1 }, "test", NOW);
      expect(await book("2026-11", "1.05")).toBe(false);
      expect(await book("2026-11", "1.05", true)).toBe(true);
    });
    it("rechaza un mes mal escrito o un monto negativo", async () => {
      await expect(book("2026-13", "1")).rejects.toThrow();
      await expect(book("nov", "1")).rejects.toThrow();
      await expect(book("2026-11", "-1")).rejects.toThrow();
    });
    it("caja_app solo lee el contador: no puede escribirlo directo", async () => {
      await book("2026-11", "1");
      await expect(
        t.db.transaction(async (tx) => {
          await tx.execute(sql`set local role caja_app`);
          await tx.execute(sql`update app.reward_month set booked_usd = 0`);
        }),
      ).rejects.toThrow();
      await expect(
        t.db.transaction(async (tx) => {
          await tx.execute(sql`set local role caja_app`);
          await tx.execute(sql`insert into app.reward_month (month) values ('2027-01')`);
        }),
      ).rejects.toThrow();
      const ok = await t.db.transaction(async (tx) => {
        await tx.execute(sql`set local role caja_app`);
        return rows<{ n: number }>(
          await tx.execute(sql`select count(*)::int as n from app.reward_month`),
        );
      });
      expect(ok[0]?.n).toBe(1);
      // Y caja_app sí puede llamar a la función.
      const viaApp = await t.db.transaction(async (tx) => {
        await tx.execute(sql`set local role caja_app`);
        return bookRewardCost(tx, "2026-11", new Decimal("0.50"), false);
      });
      expect(viaApp).toBe(true);
    });
  });

  // ------------------------------------------------------------ US-413: ajustes

  describe("interruptores y ajustes (US-413)", () => {
    it("sin fila: todo apagado y tope de $20", async () => {
      await t.db.delete(schema.appSetting);
      const f = await habitSettings(t.db);
      expect([f.xp, f.rewards, f.referrals]).toEqual([false, false, false]);
      expect((await rewardSettings(t.db)).monthlyCeilingUsd).toBe(20);
      expect((await rewardSettings(t.db)).showInviteeNames).toBe(false);
    });
    it("el tope va de 0 a 200 con dos decimales", () => {
      expect(parseCeiling("20")).toBe(20);
      expect(parseCeiling("0")).toBe(0);
      expect(parseCeiling("12.50")).toBe(12.5);
      expect(parseCeiling("200")).toBe(200);
      expect(parseCeiling("-1")).toBeNull();
      expect(parseCeiling("2000")).toBeNull();
      expect(parseCeiling("200.01")).toBeNull();
      expect(parseCeiling("1.234")).toBeNull();
      expect(parseCeiling("abc")).toBeNull();
    });
    it("encender xp guarda el día; cambiar dailyClose o referrals guarda su fecha (P-16)", () => {
      const off = { xp: false, dailyClose: false, referrals: false };
      const base = { ...(t ? {} : {}), referralsOnSince: null } as never;
      const c = rewardChangesForFlags(
        off,
        { xp: true, dailyClose: true, referrals: false },
        base,
        NOW,
      );
      expect(c).toEqual({ xpOnSince: TODAY, dailyCloseChangedOn: TODAY });
      const r = rewardChangesForFlags(off, { ...off, referrals: true }, base, NOW);
      expect(r).toEqual({ referralsChangedOn: TODAY, referralsOnSince: TODAY });
    });
  });

  // ------------------------------------------------------------ US-414: syncPoints

  describe("syncPoints (US-414)", () => {
    it("con xp apagado no hace nada", async () => {
      const tn = await tenant();
      await saveHabitSettings(t.db, { xp: false }, "test", NOW);
      expect(await sync(tn.id)).toBeNull();
      expect(await events(tn.id)).toEqual([]);
    });
    it("10 registros en un día → +5 una vez; otra sincronización no agrega filas", async () => {
      const tn = await tenant();
      for (let i = 0; i < 10; i++) await record(tn, new Date(NOW.getTime() - i * 60_000));
      await sync(tn.id);
      expect(await sumRule(tn.id, "record_day")).toBe(5);
      const before = (await events(tn.id)).length;
      await sync(tn.id);
      expect((await events(tn.id)).length).toBe(before);
    });
    it("lo que anota un empleado suma +5 al negocio", async () => {
      const tn = await tenant();
      const emp = await withTenant(t.db, tn.id, async (tx) => {
        const [p] = await tx
          .insert(schema.phoneNumber)
          .values({ tenantId: tn.id, e164: "584149990001", role: "employee", status: "active" })
          .returning();
        return p?.id ?? "";
      });
      await record(tn, NOW, { phoneId: emp });
      await sync(tn.id);
      expect(await sumRule(tn.id, "record_day")).toBe(5);
      expect(await sumRule(tn.id, "employee_joined")).toBe(15);
    });
    it("A40: puntos de una vez por lo que ya existe; ningún día antes de encender xp", async () => {
      const tn = await tenant();
      await saveRewardSettings(t.db, { xpOnSince: TODAY }, "test", NOW);
      await record(tn, daysAgo(3));
      await record(tn, NOW);
      await withTenant(t.db, tn.id, async (tx) => {
        await tx.insert(schema.account).values([
          { tenantId: tn.id, name: "Banco", currency: "VES", openingDate: TODAY, createdAt: NOW },
          {
            tenantId: tn.id,
            name: "Efectivo",
            currency: "USD",
            kind: "cash",
            openingDate: TODAY,
            createdAt: NOW,
          },
        ]);
      });
      await sync(tn.id);
      expect(await sumRule(tn.id, "signup_done")).toBe(20);
      expect(await sumRule(tn.id, "accounts_2")).toBe(15);
      expect(await sumRule(tn.id, "first_budget")).toBe(0);
      // Solo hoy: el día de hace 3 días fue antes de encender.
      expect(await sumRule(tn.id, "record_day")).toBe(5);
      const totals = await withTenant(t.db, tn.id, (tx) => pointsTotals(tx, tn.id, NOW));
      // signup_done es de hace 90 días: no cuenta como «hoy».
      expect(totals.today).toBe(5 + 15);
    });
    it("anotar y borrar el mismo día → +5 y −5 después de medianoche; borrar otro día lo deja", async () => {
      const tn = await tenant();
      const t0 = new Date("2026-11-24T14:00:00Z");
      await record(tn, t0);
      const t1 = new Date("2026-11-23T14:00:00Z");
      await record(tn, t1);
      await sync(tn.id, new Date("2026-11-24T14:00:30Z"));
      expect(await sumRule(tn.id, "record_day")).toBe(10);
      // Lo borra ese mismo día: hoy todavía no está cerrado, así que nada se quita aún.
      await withTenant(t.db, tn.id, (tx) =>
        tx
          .update(schema.movement)
          .set({ deletedAt: new Date(t0.getTime() + 60_000) })
          .where(eq(schema.movement.createdAt, t0)),
      );
      await sync(tn.id, new Date("2026-11-24T15:00:00Z"));
      expect(await sumRule(tn.id, "record_day")).toBe(10);
      // Al día siguiente el 24 quedó sin registros: −5 con su razón.
      await sync(tn.id, new Date("2026-11-25T14:00:00Z"));
      expect(await sumRule(tn.id, "record_day")).toBe(5);
      const rev = (await events(tn.id)).find((e) => e.points < 0);
      expect(rev?.reason).toBe("record_deleted");
      expect(rev?.reverses).toBeTruthy();
      // El del 23, borrado el 25 (otro día): se queda.
      await withTenant(t.db, tn.id, (tx) =>
        tx
          .update(schema.movement)
          .set({ deletedAt: new Date("2026-11-25T15:00:00Z") })
          .where(eq(schema.movement.createdAt, t1)),
      );
      await sync(tn.id, new Date("2026-11-26T14:00:00Z"));
      expect(await sumRule(tn.id, "record_day")).toBe(5);
    });
    it("racha de 7 con 4 días sin gastos → sin bono; con 4 de 7 registros → +25", async () => {
      const a = await tenant();
      for (let d = 6; d >= 0; d--) {
        if (d < 3) await record(a, daysAgo(d));
        else await noSpend(a, d);
      }
      await sync(a.id);
      expect(await sumRule(a.id, "streak_bonus")).toBe(0);
      const b = await tenant();
      for (let d = 6; d >= 0; d--) {
        if (d < 4) await record(b, daysAgo(d));
        else await noSpend(b, d);
      }
      await sync(b.id);
      expect(await sumRule(b.id, "streak_bonus")).toBe(25);
    });
    it("racha de 37 → bonos el día 7, 15, 30 y 37", async () => {
      const tn = await tenant();
      for (let d = 36; d >= 0; d--) await record(tn, daysAgo(d));
      const state = await sync(tn.id);
      const bonuses = (await events(tn.id)).filter((e) => e.rule === "streak_bonus");
      expect(bonuses.map((e) => e.points).sort((x, y) => x - y)).toEqual([25, 25, 50, 100]);
      expect(bonuses.map((e) => e.refKey.split(":")[1]).sort()).toEqual(["15", "30", "37", "7"]);
      expect(state?.bonusToday).toEqual({ points: 25, n: 37 });
    });
    it("«Eso es todo»: +2 solo con el botón de hoy, y una sola vez", async () => {
      const tn = await tenant();
      const tap = (date: IsoDate) =>
        withTenant(t.db, tn.id, (tx) => awardCloseDay(tx, tn.id, date, NOW));
      expect(await tap(addDays(TODAY, -1))).toBe(false);
      expect(await tap(TODAY)).toBe(true);
      expect(await tap(TODAY)).toBe(false);
      expect(await sumRule(tn.id, "close_day")).toBe(2);
    });
  });

  // ------------------------------------------------------------ US-415: niveles

  describe("niveles (US-415)", () => {
    it("99 → 100: Guardián una vez; 101 y −5 → sigue Guardián", async () => {
      const tn = await tenant({ crmTags: ["interna"] });
      await sync(tn.id);
      const base = (await withTenant(t.db, tn.id, (tx) => pointsTotals(tx, tn.id, NOW))).total;
      await give(tn.id, 99 - base);
      await sync(tn.id);
      expect((await tenantRow(tn.id)).pointsLevel).toBe(1);
      await give(tn.id, 2);
      await sync(tn.id);
      expect((await tenantRow(tn.id)).pointsLevel).toBe(2);
      await give(tn.id, -5);
      await sync(tn.id);
      expect((await tenantRow(tn.id)).pointsLevel).toBe(2);
      expect((await grants(tn.id)).map((g) => g.kind)).toEqual(["level_n2"]);
    });
    it("de 0 a 450 en una sincronización → regalos de Guardián y Pana Fiel, una línea", async () => {
      const tn = await tenant({ crmTags: ["interna"] });
      await give(tn.id, 450);
      await sync(tn.id);
      expect((await grants(tn.id)).map((g) => g.kind).sort()).toEqual(["level_n2", "level_n3"]);
      const notes = await withTenant(t.db, tn.id, (tx) =>
        tx.select().from(schema.pointsNotice).where(eq(schema.pointsNotice.tenantId, tn.id)),
      );
      expect(notes).toHaveLength(1);
      expect((notes[0]?.args as { level: number }).level).toBe(3);
      // A41: cuenta interna → `test`, sin tocar el cobro ni el tope.
      expect((await grants(tn.id)).every((g) => g.status === "test")).toBe(true);
      expect((await tenantRow(tn.id)).extraMessages).toBe(0);
      expect(await t.db.select().from(schema.rewardMonth)).toEqual([]);
    });
  });

  // ------------------------------------------------------------ US-416: regalos y tope

  describe("regalos y tope (US-416)", () => {
    it("Guardián en la prueba: el tope sube a 120 mensajes (y $4.80)", async () => {
      const tn = await tenant();
      await give(tn.id, 100);
      await sync(tn.id);
      const row = await tenantRow(tn.id);
      expect(row.extraMessages).toBe(20);
      const { trialBudget, trialMessageCap } = await import("../src/billing/trial");
      expect(trialMessageCap(row)).toBe(120);
      expect(trialBudget(row).toFixed(2)).toBe("4.80");
      const [g] = await grants(tn.id);
      expect(g?.status).toBe("applied");
      expect(g?.costUsdEstimate).toBe("0.42");
      const note = await withTenant(t.db, tn.id, (tx) => nextNotice(tx, tn.id));
      expect(note?.args).toMatchObject({ level: 2, benefit: "messages", trial: true, tope: 120 });
    });
    it("Guardián en un plan pagado el 30: los mensajes valen este mes", async () => {
      const tn = await tenant({
        status: "active",
        paidUntil: new Date("2026-12-20T00:00:00Z"),
      });
      await give(tn.id, 100);
      const at = new Date("2026-11-30T16:00:00Z");
      await sync(tn.id, at);
      const row = await tenantRow(tn.id);
      expect([row.extraMessages, row.extraMonth]).toEqual([20, "2026-11"]);
      const note = await withTenant(t.db, tn.id, (tx) => nextNotice(tx, tn.id));
      expect(note?.args).toMatchObject({ vence: "2026-11-30" });
    });
    it("tope $1 y Pana Fiel pagado ($1.05) → espera; llega el 1 aunque pase el tope", async () => {
      await saveRewardSettings(t.db, { monthlyCeilingUsd: 1 }, "test", NOW);
      const tn = await tenant({ status: "active", paidUntil: new Date("2027-01-20T00:00:00Z") });
      await give(tn.id, 100);
      await sync(tn.id); // Guardián: $0.42 cabe
      await give(tn.id, 300);
      await sync(tn.id); // Pana Fiel: no cabe
      const n3 = (await grants(tn.id)).find((g) => g.kind === "level_n3");
      expect([n3?.status, n3?.waitReason]).toEqual(["waiting", "ceiling"]);
      // El 1 de diciembre: se entrega y se reserva en diciembre sin mirar el tope.
      const dec1 = new Date("2026-12-01T12:00:00Z");
      const r = await runPointsHousekeeping(t.db, dec1);
      expect(r.released).toBeGreaterThanOrEqual(1);
      const after = (await grants(tn.id)).find((g) => g.kind === "level_n3");
      expect([after?.status, after?.bookedMonth]).toEqual(["applied", "2026-12"]);
      expect((await tenantRow(tn.id)).extraMessages).toBe(50);
      // Otra corrida del mismo mes no lo aplica dos veces.
      await runPointsHousekeeping(t.db, new Date("2026-12-01T12:05:00Z"));
      expect((await tenantRow(tn.id)).extraMessages).toBe(50);
    });
    it("dos corridas de la entrega a la vez → cada regalo una vez (SEC-P4-9 b)", async () => {
      await saveRewardSettings(t.db, { monthlyCeilingUsd: 0.5 }, "test", NOW);
      const tn = await tenant({ status: "active", paidUntil: new Date("2027-01-20T00:00:00Z") });
      await give(tn.id, 1200);
      await sync(tn.id);
      const oro = (await grants(tn.id)).find((g) => g.kind === "level_n4");
      expect(oro?.waitReason).toBe("ceiling");
      const before = (await tenantRow(tn.id)).paidUntil?.getTime() ?? 0;
      await saveRewardSettings(t.db, { releasedMonth: null }, "test", NOW);
      const dec1 = new Date("2026-12-01T12:00:00Z");
      await Promise.all([runPointsHousekeeping(t.db, dec1), runPointsHousekeeping(t.db, dec1)]);
      const after = (await tenantRow(tn.id)).paidUntil?.getTime() ?? 0;
      expect(after - before).toBe(7 * DAY);
    });
    it("tope en 0 → pausa (RW2-hold); no sale el 1; al volver a $20 sale", async () => {
      await saveRewardSettings(t.db, { monthlyCeilingUsd: 0 }, "test", NOW);
      const tn = await tenant();
      await give(tn.id, 100);
      await sync(tn.id);
      const [g] = await grants(tn.id);
      expect([g?.status, g?.waitReason]).toEqual(["waiting", "paused"]);
      const note = await withTenant(t.db, tn.id, (tx) => nextNotice(tx, tn.id));
      expect(note?.args).toMatchObject({ outcome: "paused" });
      await runPointsHousekeeping(t.db, new Date("2026-12-01T12:00:00Z"));
      expect((await grants(tn.id))[0]?.status).toBe("waiting");
      await saveRewardSettings(t.db, { monthlyCeilingUsd: 20 }, "test", NOW);
      await sync(tn.id, new Date("2026-12-02T12:00:00Z"));
      expect((await grants(tn.id))[0]?.status).toBe("applied");
    });
    it("con `rewards` apagado el nivel sube y el regalo espera (flag_off); al encender, sale", async () => {
      await saveHabitSettings(t.db, { rewards: false }, "test", NOW);
      const tn = await tenant();
      await give(tn.id, 100);
      await sync(tn.id);
      expect((await tenantRow(tn.id)).pointsLevel).toBe(2);
      expect((await grants(tn.id))[0]?.waitReason).toBe("flag_off");
      await saveHabitSettings(t.db, { rewards: true }, "test", NOW);
      await sync(tn.id);
      expect((await grants(tn.id))[0]?.status).toBe("applied");
      expect((await tenantRow(tn.id)).extraMessages).toBe(20);
    });
    it("Oro en la prueba → espera el pago; con el primer pago: meses + 7 días", async () => {
      const tn = await tenant();
      await give(tn.id, 1200);
      await sync(tn.id);
      const oro = (await grants(tn.id)).find((g) => g.kind === "level_n4");
      expect([oro?.status, oro?.waitReason]).toEqual(["waiting", "not_paying"]);
      const { paidUntil } = await withTenant(t.db, tn.id, (tx) =>
        recordPayment(
          tx,
          {
            tenantId: tn.id,
            plan: "personal",
            months: 1,
            method: "zelle",
            amount: new Decimal("5.99"),
            currency: "USD",
            rateKind: null,
            rateValue: null,
            amountUsd: new Decimal("5.99"),
            reference: null,
            notes: null,
          },
          reviewer,
          NOW,
          { approve: true },
        ),
      );
      const row = await tenantRow(tn.id);
      const trialEnd = row.trialEndsAt?.getTime() ?? 0;
      expect(paidUntil?.getTime()).toBe(Math.max(trialEnd, NOW.getTime()) + 37 * DAY);
      expect((await grants(tn.id)).find((g) => g.kind === "level_n4")?.status).toBe("applied");
    });
    it("Pana Fiel con la prueba en su tope → espera; +50 mensajes con el primer pago", async () => {
      const tn = await tenant();
      await withTenant(t.db, tn.id, async (tx) => {
        const [p] = await tx.select().from(schema.phoneNumber);
        await tx.insert(schema.message).values(
          Array.from({ length: 121 }, () => ({
            tenantId: tn.id,
            phoneId: p?.id ?? "",
            direction: "in",
            kind: "text",
            status: "ok",
          })),
        );
      });
      await give(tn.id, 400);
      await sync(tn.id);
      const n3 = (await grants(tn.id)).find((g) => g.kind === "level_n3");
      expect([n3?.status, n3?.waitReason]).toEqual(["waiting", "not_paying"]);
      const pay = await withTenant(t.db, tn.id, (tx) =>
        recordPayment(
          tx,
          {
            tenantId: tn.id,
            plan: "personal",
            months: 1,
            method: "zelle",
            amount: new Decimal("5.99"),
            currency: "USD",
            rateKind: null,
            rateValue: null,
            amountUsd: new Decimal("5.99"),
            reference: null,
            notes: null,
          },
          reviewer,
          NOW,
          { approve: false },
        ),
      );
      await withTenant(t.db, tn.id, (tx) =>
        approvePayment(tx, tn.id, pay.paymentId, reviewer, NOW),
      );
      expect((await grants(tn.id)).find((g) => g.kind === "level_n3")?.appliedAs).toBe("messages");
      // Guardián (+20, en la prueba, siguen en el mes) y Pana Fiel (+50) al pagar.
      expect((await tenantRow(tn.id)).extraMessages).toBe(70);
    });
    it("dos meses por encima del tope → alerta de /admin", async () => {
      await t.db.insert(schema.rewardMonth).values([
        { month: "2026-10", bookedUsd: "25.00" },
        { month: "2026-11", bookedUsd: "21.00" },
      ]);
      await saveRewardSettings(t.db, { releasedMonth: "2026-11" }, "test", NOW);
      await runPointsHousekeeping(t.db, new Date("2026-12-01T12:00:00Z"));
      const s = await rewardSettings(t.db);
      expect([s.alertMonth, s.alertDismissed]).toEqual(["2026-12", false]);
    });
  });

  // ------------------------------------------------------------ US-417: Leyenda

  describe("Leyenda (US-417, D18)", () => {
    it("Personal fundador 1 mes → $3.23; Negocio 3 meses precio completo → $53.97", () => {
      const rates = null;
      expect(
        quote(planById("personal"), "zelle", 1, rates, "bcv_eur", 40, 10)?.amountUsd.toFixed(2),
      ).toBe("3.23");
      expect(
        quote(planById("negocio"), "zelle", 3, rates, "bcv_eur", 0, 10)?.amountUsd.toFixed(2),
      ).toBe("53.97");
    });
    async function leyenda(opts: Partial<typeof schema.tenant.$inferInsert>) {
      const tn = await tenant({ status: "active", paidUntil: daysAgo(-10), ...opts });
      await give(tn.id, 3000);
      await sync(tn.id);
      return tn;
    }
    it("suspendido 20 días y paga → sigue el 10 %; suspendido 31 → ya no", async () => {
      const pct = async (id: string, opts?: { reportedAt?: Date; approving?: boolean }) => {
        const row = await tenantRow(id);
        return withTenant(t.db, id, (tx) => leyendaPct(tx, row, NOW, opts));
      };
      const a = await leyenda({ status: "active" });
      await withTenant(t.db, a.id, (tx) =>
        tx
          .update(schema.tenant)
          .set({ status: "suspended", suspendedAt: daysAgo(20) })
          .where(eq(schema.tenant.id, a.id)),
      );
      expect(await pct(a.id)).toBe(10);
      const b = await leyenda({ status: "active" });
      await withTenant(t.db, b.id, (tx) =>
        tx
          .update(schema.tenant)
          .set({ status: "suspended", suspendedAt: daysAgo(31) })
          .where(eq(schema.tenant.id, b.id)),
      );
      expect(await pct(b.id)).toBe(0);
      // Terminado para siempre, aunque después pague.
      await withTenant(t.db, b.id, (tx) =>
        tx
          .update(schema.tenant)
          .set({ status: "active", suspendedAt: null })
          .where(eq(schema.tenant.id, b.id)),
      );
      expect(await pct(b.id)).toBe(0);
    });
    it("reportado el día del vencimiento y aprobado 4 días después → 10 % (y sigue)", async () => {
      const tn = await leyenda({ status: "active" });
      await withTenant(t.db, tn.id, (tx) =>
        tx
          .update(schema.tenant)
          .set({ status: "suspended", suspendedAt: daysAgo(33) })
          .where(eq(schema.tenant.id, tn.id)),
      );
      const row = await tenantRow(tn.id);
      const at = await withTenant(t.db, tn.id, (tx) =>
        leyendaPct(tx, row, NOW, { reportedAt: daysAgo(34), approving: true }),
      );
      expect(at).toBe(10);
      // Y sigue para el próximo pago (pagó a tiempo).
      const row2 = await tenantRow(tn.id);
      const later = await withTenant(t.db, tn.id, (tx) =>
        leyendaPct(tx, { ...row2, status: "active", suspendedAt: null }, NOW),
      );
      expect(later).toBe(10);
    });
    it("al aprobar un pago con el 10 %, su costo se reserva sin mirar el tope", async () => {
      await saveRewardSettings(t.db, { monthlyCeilingUsd: 0 }, "test", NOW);
      const tn = await leyenda({});
      await withTenant(t.db, tn.id, (tx) =>
        recordPayment(
          tx,
          {
            tenantId: tn.id,
            plan: "negocio",
            months: 1,
            method: "zelle",
            amount: new Decimal("17.99"),
            currency: "USD",
            rateKind: null,
            rateValue: null,
            amountUsd: new Decimal("17.99"),
            reference: null,
            notes: null,
          },
          reviewer,
          NOW,
          { approve: true },
        ),
      );
      const [m] = await t.db.select().from(schema.rewardMonth);
      expect(m?.bookedUsd).toBe("2.00");
    });
  });

  // ------------------------------------------------------------ US-432: quitar puntos

  describe("quitar puntos (US-432)", () => {
    it("30 de 120 → 90, mismo nivel, RW8h pendiente; repetir no quita dos veces; más que el total no", async () => {
      const tn = await tenant({ crmTags: ["interna"] });
      await sync(tn.id);
      const base = (await withTenant(t.db, tn.id, (tx) => pointsTotals(tx, tn.id, NOW))).total;
      await give(tn.id, 120 - base);
      await sync(tn.id);
      const actionId = randomUUID();
      const r = await withTenant(t.db, tn.id, (tx) =>
        removePoints(tx, tn.id, { actionId, points: 30, reason: "fake_records" }, NOW),
      );
      expect(r).toEqual({ before: 120, after: 90 });
      expect((await tenantRow(tn.id)).pointsLevel).toBe(2);
      const again = await withTenant(t.db, tn.id, (tx) =>
        removePoints(tx, tn.id, { actionId, points: 30, reason: "fake_records" }, NOW),
      );
      expect(again).toBeNull();
      const tooMuch = await withTenant(t.db, tn.id, (tx) =>
        removePoints(tx, tn.id, { actionId: randomUUID(), points: 91, reason: "our_error" }, NOW),
      );
      expect(tooMuch).toBeNull();
      const notes = await withTenant(t.db, tn.id, (tx) =>
        tx.select().from(schema.pointsNotice).where(eq(schema.pointsNotice.kind, "points_removed")),
      );
      expect(notes.map((x) => x.args)).toEqual([{ k: 30, motivo: "fake_records" }]);
    });
  });
});
