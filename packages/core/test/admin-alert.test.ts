import { eq, schema, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_ALERT_KEY, paymentAlertLine, runPaymentAlerts } from "../src/billing/admin-alert";
import { reportPayment } from "../src/billing/payments";
import { Decimal } from "../src/domain/money";
import { MetaClient } from "../src/whatsapp/client";

/** Aviso al administrador de cada pago reportado (decisión del fundador, 06/11). */
const ADMIN = "584140000001";
const NOW = new Date("2026-11-07T15:00:00Z");
const MIN = 60_000;

type Sent = { to: string; type: string; body?: string; params?: string[] };

function fakeMeta(opts: { fail?: boolean } = {}) {
  const sent: Sent[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (opts.fail)
      return new Response(JSON.stringify({ error: { message: "caído", code: 1 } }), {
        status: 500,
      });
    const b = JSON.parse(String(init?.body)) as {
      to: string;
      type: string;
      text?: { body: string };
      template?: { components?: { parameters: { text: string }[] }[] };
    };
    sent.push({
      to: b.to,
      type: b.type,
      ...(b.text ? { body: b.text.body } : {}),
      ...(b.template
        ? { params: b.template.components?.[0]?.parameters.map((p) => p.text) ?? [] }
        : {}),
    });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.A${sent.length}` }] }), {
      status: 200,
    });
  }) as typeof fetch;
  return { sent, client: new MetaClient({ accessToken: "T", phoneNumberId: "P", fetchImpl }) };
}

describe("aviso de pagos al administrador", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let shop: string;
  let admin: string;
  let adminPhone: string;

  const report = (at: Date, over: Partial<Parameters<typeof reportPayment>[1]> = {}) =>
    withTenant(t.db, shop, (tx) =>
      reportPayment(
        tx,
        {
          tenantId: shop,
          plan: "negocio",
          months: 1,
          method: "pago_movil",
          amount: new Decimal("1234.56"),
          currency: "VES",
          rateKind: "bcv_usd",
          rateValue: new Decimal("200"),
          amountUsd: new Decimal("6.17"),
          reference: "REF-SECRETA-123",
          notes: "Reportado por WhatsApp",
          ...over,
        },
        { phoneId: "00000000-0000-4000-8000-000000000000" },
        at,
      ).then(async (r) => {
        // `created_at` lo pone la base con su reloj: se fija para la prueba.
        await tx
          .update(schema.payment)
          .set({ createdAt: at })
          .where(eq(schema.payment.id, r.paymentId));
        return r;
      }),
    );

  /** El administrador le escribió a Rocco en `at` (abre la ventana de 24 h). */
  const adminWrote = (at: Date) =>
    withTenant(t.db, admin, (tx) =>
      tx.insert(schema.message).values({
        tenantId: admin,
        phoneId: adminPhone,
        direction: "in",
        kind: "text",
        body: "hola",
        waMessageId: `wamid.in${at.getTime()}`,
        createdAt: at,
      }),
    );

  const run = (meta: MetaClient | null, now: Date, template = false, e164: string | null = ADMIN) =>
    runPaymentAlerts(t.db, meta, {
      adminE164: e164,
      template: template ? { name: "rocco_pago_por_verificar", language: "es" } : null,
      dashboardUrl: "https://holarocco.com/",
      now,
    });

  beforeAll(async () => {
    t = await createTestDb();
    shop = await seedTenant(t.db, {
      name: "Bodega La Esquina",
      businessType: "retail",
      ownerPhone: "584241112233",
    });
    admin = await seedTenant(t.db, {
      name: "Rocco interno",
      businessType: "other",
      ownerPhone: ADMIN,
    });
    const [p] = await withTenant(t.db, admin, (tx) =>
      tx
        .select({ id: schema.phoneNumber.id })
        .from(schema.phoneNumber)
        .where(eq(schema.phoneNumber.tenantId, admin)),
    );
    adminPhone = p?.id ?? "";
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.db.delete(schema.appSetting).where(eq(schema.appSetting.key, ADMIN_ALERT_KEY));
    for (const id of [shop, admin])
      await withTenant(t.db, id, async (tx) => {
        await tx.delete(schema.auditLog).where(eq(schema.auditLog.tenantId, id));
        await tx.delete(schema.payment).where(eq(schema.payment.tenantId, id));
        await tx.delete(schema.message).where(eq(schema.message.tenantId, id));
      });
  });

  it("sin el número del administrador no hace nada (ni guarda el estado)", async () => {
    await report(NOW);
    const meta = fakeMeta();
    expect(await run(meta.client, NOW, false, null)).toEqual({ status: "off" });
    expect(meta.sent).toHaveLength(0);
    const st = await t.db
      .select()
      .from(schema.appSetting)
      .where(eq(schema.appSetting.key, ADMIN_ALERT_KEY));
    expect(st).toHaveLength(0);
  });

  it("la primera vez avisa cuántos hay por verificar; después, solo los nuevos y una vez", async () => {
    await report(new Date(NOW.getTime() - 3 * 3_600_000));
    await adminWrote(new Date(NOW.getTime() - 60 * MIN));
    const meta = fakeMeta();
    expect(await run(meta.client, NOW)).toMatchObject({ status: "sent", via: "text", pending: 1 });
    expect(meta.sent[0]?.to).toBe(ADMIN);
    expect(meta.sent[0]?.body).toContain("Hay 1 pago por verificar.");
    // Nada nuevo: no escribe.
    expect(await run(meta.client, new Date(NOW.getTime() + MIN))).toEqual({ status: "none" });
    // Un pago nuevo: un aviso, con el total.
    await report(new Date(NOW.getTime() + 2 * MIN));
    expect(await run(meta.client, new Date(NOW.getTime() + 3 * MIN))).toMatchObject({
      status: "sent",
      newPayments: 1,
      pending: 2,
    });
    expect(meta.sent[1]?.body).toBe(
      [
        "Nuevo pago por verificar:",
        "• Plan Negocio · 1 mes · Pago móvil · Bs 1.234,56",
        "Por verificar en total: 2.",
        "Revísalos en https://holarocco.com/admin",
      ].join("\n"),
    );
    expect(await run(meta.client, new Date(NOW.getTime() + 4 * MIN))).toEqual({ status: "none" });
    expect(meta.sent).toHaveLength(2);
  });

  it("no lleva el nombre del negocio, ni teléfonos, ni la referencia", async () => {
    await run(fakeMeta().client, NOW); // primera vuelta, sin pagos
    await adminWrote(NOW);
    await report(new Date(NOW.getTime() + MIN));
    const meta = fakeMeta();
    await run(meta.client, new Date(NOW.getTime() + 2 * MIN));
    const body = meta.sent[0]?.body ?? "";
    expect(body).not.toContain("Bodega");
    expect(body).not.toContain("REF-SECRETA");
    expect(body).not.toMatch(/58\d{9,}/);
  });

  it("ventana cerrada: la plantilla si está configurada; si no, no sale nada y se avisa", async () => {
    await run(fakeMeta().client, NOW);
    await adminWrote(new Date(NOW.getTime() - 25 * 3_600_000));
    await report(new Date(NOW.getTime() + MIN));
    const meta = fakeMeta();
    expect(await run(meta.client, new Date(NOW.getTime() + 2 * MIN))).toMatchObject({
      status: "no_window",
      newPayments: 1,
    });
    expect(meta.sent).toHaveLength(0);
    await report(new Date(NOW.getTime() + 3 * MIN), {
      kind: "recharge",
      method: "binance",
      currency: "USDT",
      amount: new Decimal("5"),
      extraMessages: 500,
    });
    expect(await run(meta.client, new Date(NOW.getTime() + 4 * MIN), true)).toMatchObject({
      status: "sent",
      via: "template",
    });
    expect(meta.sent[0]).toMatchObject({
      type: "template",
      params: ["Recarga de 500 mensajes · Binance · $5,00 USDT"],
    });
  });

  it("si Meta falla, no repite el aviso cada minuto", async () => {
    await run(fakeMeta().client, NOW);
    await adminWrote(NOW);
    await report(new Date(NOW.getTime() + MIN));
    const down = fakeMeta({ fail: true });
    expect(await run(down.client, new Date(NOW.getTime() + 2 * MIN))).toMatchObject({
      status: "failed",
    });
    expect(await run(fakeMeta().client, new Date(NOW.getTime() + 3 * MIN))).toEqual({
      status: "none",
    });
  });

  it("la línea de un plan de varios meses", () => {
    expect(
      paymentAlertLine({
        id: "x",
        createdAt: NOW,
        kind: "plan",
        plan: "personal",
        months: 3,
        method: "zelle",
        amount: "15",
        currency: "USD",
        extraMessages: null,
      }),
    ).toBe("Plan Personal · 3 meses · Zelle · $15,00");
  });
});
