import { eq, schema, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvePayment,
  enforceBilling,
  extendPaidUntil,
  latestRates,
  PERIOD_DAYS,
  planById,
  quote,
  recordPayment,
  rejectPayment,
  reportPayment,
  subscriptionState,
  TooManyPendingError,
} from "../src/billing/index";
import { Decimal } from "../src/domain/money";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-02T15:00:00Z");
const reviewer = { userId: "33333333-3333-4333-8333-333333333333", email: "admin@test" };

describe("estado de la suscripción", () => {
  const at = (days: number) => new Date(now.getTime() + days * DAY);
  it("prueba, gracia de 3 días, vencido y suspendido", () => {
    const trial = { status: "trial", trialEndsAt: at(5), paidUntil: null };
    expect(subscriptionState(trial, now)).toMatchObject({ kind: "trial", daysLeft: 5 });
    expect(subscriptionState({ ...trial, trialEndsAt: at(-2) }, now).kind).toBe("grace");
    expect(subscriptionState({ ...trial, trialEndsAt: at(-4) }, now).kind).toBe("expired");
    expect(subscriptionState({ ...trial, status: "suspended" }, now).kind).toBe("suspended");
    // Activo sin fecha: cortesía, nunca vence.
    expect(
      subscriptionState({ status: "active", trialEndsAt: null, paidUntil: null }, now).kind,
    ).toBe("active");
  });
  it("pagar durante la prueba suma desde el fin de la prueba; pagar adelantado no pierde días", () => {
    const fromTrial = extendPaidUntil(
      { status: "trial", trialEndsAt: at(10), paidUntil: null },
      1,
      now,
      PERIOD_DAYS,
    );
    expect(fromTrial.getTime()).toBe(at(40).getTime());
    const late = extendPaidUntil(
      { status: "active", trialEndsAt: null, paidUntil: at(-20) },
      2,
      now,
      PERIOD_DAYS,
    );
    expect(late.getTime()).toBe(at(60).getTime());
  });
});

describe("monto a cobrar", () => {
  const rates = {
    effectiveDate: "2026-10-01",
    usd: new Decimal("860.17"),
    eur: new Decimal("976.84"),
  };
  const negocio = planById("negocio");
  it("pago móvil a tasa euro; Zelle y Binance al precio del plan", () => {
    expect(quote(negocio, "pago_movil", 1, rates)).toMatchObject({
      currency: "VES",
      rateKind: "bcv_eur",
    });
    expect(quote(negocio, "pago_movil", 1, rates)?.amount.toFixed(2)).toBe("19527.03");
    expect(quote(negocio, "zelle", 2, rates)?.amount.toFixed(2)).toBe("39.98");
    expect(quote(negocio, "binance", 1, rates)).toMatchObject({ currency: "USDT" });
  });
  it("sin euro conocido cae a la tasa del dólar; sin tasas no cotiza pago móvil", () => {
    expect(quote(negocio, "pago_movil", 1, { ...rates, eur: null })?.rateKind).toBe("bcv_usd");
    expect(quote(negocio, "pago_movil", 1, null)).toBeNull();
    expect(quote(negocio, "pago_movil", 1, rates, "bcv_usd")?.amount.toFixed(2)).toBe("17194.80");
  });
});

describe("pagos, suspensión y límite (base de prueba)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Autolavado",
      businessType: "car_wash",
      ownerPhone: "584121234567",
    });
    await t.db.insert(schema.bcvRate).values([
      { effectiveDate: "2026-09-30", rate: "859.06", rateEur: "973.31", source: "test" },
      { effectiveDate: "2026-10-01", rate: "860.17", source: "test" },
    ]);
  });
  afterAll(() => t.close());
  const tenant = async () =>
    (
      await withTenant(t.db, tenantId, (tx) =>
        tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId)),
      )
    )[0];

  it("un negocio nuevo arranca con 14 días de prueba", async () => {
    const row = await tenant();
    expect(row?.status).toBe("trial");
    expect(row?.plan).toBe("negocio");
    const days = ((row?.trialEndsAt?.getTime() ?? 0) - (row?.createdAt.getTime() ?? 0)) / DAY;
    expect(Math.round(days)).toBe(14);
  });

  it("la última tasa trae el último euro conocido aunque sea de un día anterior", async () => {
    const r = await latestRates(t.db);
    expect(r?.effectiveDate).toBe("2026-10-01");
    expect(r?.usd.toFixed(2)).toBe("860.17");
    expect(r?.eur?.toFixed(2)).toBe("973.31");
  });

  it("registrar y aprobar un pago activa el negocio, cambia el plan y deja auditoría; rechazar no extiende", async () => {
    const pending = await withTenant(t.db, tenantId, (tx) =>
      recordPayment(
        tx,
        {
          tenantId,
          plan: "personal",
          months: 1,
          method: "zelle",
          amount: new Decimal("4.99"),
          currency: "USD",
          rateKind: null,
          rateValue: null,
          amountUsd: new Decimal("4.99"),
          reference: "ZL-1",
          notes: null,
        },
        reviewer,
        now,
        { approve: false },
      ),
    );
    expect(pending.paidUntil).toBeNull();
    await withTenant(t.db, tenantId, (tx) =>
      rejectPayment(tx, tenantId, pending.paymentId, reviewer, "no llegó", now),
    );
    expect((await tenant())?.status).toBe("trial");

    const ok = await withTenant(t.db, tenantId, (tx) =>
      recordPayment(
        tx,
        {
          tenantId,
          plan: "negocio",
          months: 1,
          method: "pago_movil",
          amount: new Decimal("19456.47"),
          currency: "VES",
          rateKind: "bcv_eur",
          rateValue: new Decimal("973.31"),
          amountUsd: new Decimal("19.99"),
          reference: "PM-123",
          notes: null,
        },
        reviewer,
        now,
        { approve: true },
      ),
    );
    const row = await tenant();
    expect(row?.status).toBe("active");
    expect(row?.paidUntil?.getTime()).toBe(ok.paidUntil?.getTime());
    await expect(
      withTenant(t.db, tenantId, (tx) => approvePayment(tx, tenantId, ok.paymentId, reviewer, now)),
    ).rejects.toThrow(/ya está approved/);
    const audits = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.auditLog).where(eq(schema.auditLog.channel, "admin")),
    );
    expect(audits.map((a) => a.action).sort()).toEqual([
      "approve_payment",
      "create",
      "create",
      "reject",
    ]);
  });

  it("el cliente reporta un pago: queda por verificar, no activa nada y hay tope de 3 pendientes", async () => {
    const before = await tenant();
    const user = { userId: "44444444-4444-4444-8444-444444444444", email: "dueno@test" };
    const report = (ref: string) =>
      withTenant(t.db, tenantId, (tx) =>
        reportPayment(
          tx,
          {
            tenantId,
            plan: "negocio_plus",
            months: 1,
            method: "binance",
            amount: new Decimal("39.99"),
            currency: "USDT",
            rateKind: null,
            rateValue: null,
            amountUsd: new Decimal("39.99"),
            reference: ref,
            notes: null,
          },
          user,
          now,
        ),
      );
    await report("BN-1");
    await report("BN-2");
    await report("BN-3");
    await expect(report("BN-4")).rejects.toBeInstanceOf(TooManyPendingError);
    const after = await tenant();
    expect(after).toMatchObject({ status: before?.status, plan: before?.plan });
    const rows = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.auditLog).where(eq(schema.auditLog.action, "report")),
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.channel === "dashboard" && r.actorType === "user")).toBe(true);
    await withTenant(t.db, tenantId, (tx) =>
      tx
        .update(schema.payment)
        .set({ status: "rejected" })
        .where(eq(schema.payment.status, "pending")),
    );
  });

  it("vencido más 3 días de gracia: se suspende; sobre el límite: avisa una sola vez por mes", async () => {
    const ids = { tenantId };
    // Vence el pago hace 5 días.
    await withTenant(t.db, tenantId, (tx) =>
      tx
        .update(schema.tenant)
        .set({ paidUntil: new Date(now.getTime() - 5 * DAY) })
        .where(eq(schema.tenant.id, ids.tenantId)),
    );
    const first = await enforceBilling(t.db, now);
    expect(first.suspended).toEqual([tenantId]);
    expect((await tenant())?.status).toBe("suspended");

    // Reactivado y con 601 mensajes este mes en el plan Negocio (600).
    await withTenant(t.db, tenantId, async (tx) => {
      await tx
        .update(schema.tenant)
        .set({ status: "active", paidUntil: new Date(now.getTime() + 20 * DAY) })
        .where(eq(schema.tenant.id, ids.tenantId));
      const [phone] = await tx.select().from(schema.phoneNumber);
      await tx.insert(schema.message).values(
        Array.from({ length: 601 }, () => ({
          tenantId,
          phoneId: phone?.id ?? "",
          direction: "in",
          kind: "text",
          body: "x",
          createdAt: now,
        })),
      );
    });
    const second = await enforceBilling(t.db, now);
    expect(second.suspended).toEqual([]);
    expect(second.overCap).toEqual([{ tenantId, plan: "negocio", used: 601, cap: 600 }]);
    const third = await enforceBilling(t.db, now);
    expect(third.overCap).toEqual([]);
  });
});
