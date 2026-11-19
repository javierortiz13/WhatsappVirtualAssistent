import { eq, schema, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN_ALERT_KEY,
  ADMIN_EMAIL_DAILY_CAP,
  paymentAlertLine,
  runPaymentAlerts,
} from "../src/billing/admin-alert";
import { AdminEmailError, type AdminMail, ResendMailer } from "../src/billing/admin-email";
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

function fakeMailer(opts: { fail?: boolean } = {}) {
  const mails: AdminMail[] = [];
  return {
    mails,
    mailer: {
      async send(m: AdminMail) {
        if (opts.fail) throw new AdminEmailError(500);
        mails.push(m);
      },
    },
  };
}

describe("aviso de pagos al administrador", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let shop: string;
  let admin: string;
  let adminPhone: string;

  const report = (
    at: Date,
    over: Partial<Parameters<typeof reportPayment>[1]> = {},
    tenantId = shop,
  ) =>
    withTenant(t.db, tenantId, (tx) =>
      reportPayment(
        tx,
        {
          tenantId,
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

  const runMail = (
    mailer: ReturnType<typeof fakeMailer>["mailer"] | null,
    now: Date,
    meta: MetaClient | null = null,
  ) =>
    runPaymentAlerts(t.db, meta, {
      adminE164: meta ? ADMIN : null,
      template: null,
      mailer,
      dashboardUrl: "https://holarocco.com/",
      now,
    });

  it("correo: un pago nuevo es un correo, y el mismo pago no se repite", async () => {
    const m = fakeMailer();
    expect(await runMail(m.mailer, NOW)).toEqual({ status: "none" }); // primera vuelta, sin pagos
    await report(new Date(NOW.getTime() + MIN));
    expect(await runMail(m.mailer, new Date(NOW.getTime() + 2 * MIN))).toMatchObject({
      status: "off",
      email: "sent",
      newPayments: 1,
      pending: 1,
    });
    expect(m.mails).toEqual([
      {
        subject: "Rocco: pago por verificar",
        text: [
          "Nuevo pago por verificar:",
          "• Plan Negocio · 1 mes · Pago móvil · Bs 1.234,56",
          "Revísalos en https://holarocco.com/admin/pagos",
        ].join("\n"),
      },
    ]);
    expect(await runMail(m.mailer, new Date(NOW.getTime() + 3 * MIN))).toEqual({
      status: "none",
    });
    expect(m.mails).toHaveLength(1);
  });

  it("correo y WhatsApp comparten el «ya avisado»: un solo aviso por cada camino", async () => {
    const m = fakeMailer();
    const meta = fakeMeta();
    await runMail(m.mailer, NOW, meta.client);
    await adminWrote(NOW);
    await report(new Date(NOW.getTime() + MIN));
    expect(await runMail(m.mailer, new Date(NOW.getTime() + 2 * MIN), meta.client)).toMatchObject({
      status: "sent",
      via: "text",
      email: "sent",
    });
    expect(await runMail(m.mailer, new Date(NOW.getTime() + 3 * MIN), meta.client)).toEqual({
      status: "none",
    });
    expect(meta.sent).toHaveLength(1);
    expect(m.mails).toHaveLength(1);
    expect(meta.sent[0]?.body?.endsWith("Revísalos en https://holarocco.com/admin")).toBe(true);
  });

  it("correo: 7 pagos del mismo minuto van en uno, con 5 líneas y «y 2 más»", async () => {
    const m = fakeMailer();
    await runMail(m.mailer, NOW);
    // Un negocio tiene como mucho 3 pagos por verificar: 3 + 3 + 1 en tres negocios.
    const more = [
      await seedTenant(t.db, {
        name: "Otro 1",
        businessType: "retail",
        ownerPhone: "584241110001",
      }),
      await seedTenant(t.db, {
        name: "Otro 2",
        businessType: "retail",
        ownerPhone: "584241110002",
      }),
    ];
    const owners = [shop, shop, shop, more[0], more[0], more[0], more[1]];
    for (const [i, id] of owners.entries())
      await report(new Date(NOW.getTime() + MIN + i * 1000), {}, id);
    await runMail(m.mailer, new Date(NOW.getTime() + 2 * MIN));
    for (const id of more)
      await withTenant(t.db, id, (tx) =>
        tx.delete(schema.payment).where(eq(schema.payment.tenantId, id)),
      );
    expect(m.mails).toHaveLength(1);
    const lines = (m.mails[0]?.text ?? "").split("\n");
    expect(lines[0]).toBe("7 pagos nuevos por verificar:");
    expect(lines.filter((l) => l.startsWith("• Plan"))).toHaveLength(5);
    expect(lines).toContain("• y 2 más");
  });

  it("correo: sin cliente de correo ni número, no sale nada", async () => {
    await report(NOW);
    expect(await runMail(null, NOW)).toEqual({ status: "off" });
  });

  it("correo: tope de 20 al día de Caracas; al día siguiente vuelve", async () => {
    const m = fakeMailer();
    await runMail(m.mailer, NOW);
    let at = NOW.getTime();
    // Se verifica cada pago antes del siguiente: un negocio tiene como mucho 3 por verificar.
    const clear = () =>
      withTenant(t.db, shop, (tx) =>
        tx.delete(schema.payment).where(eq(schema.payment.tenantId, shop)),
      );
    for (let i = 0; i < ADMIN_EMAIL_DAILY_CAP; i++) {
      at += 2 * MIN;
      await clear();
      await report(new Date(at - MIN));
      await runMail(m.mailer, new Date(at));
    }
    await clear();
    expect(m.mails).toHaveLength(ADMIN_EMAIL_DAILY_CAP);
    at += 2 * MIN;
    await report(new Date(at - MIN));
    expect(await runMail(m.mailer, new Date(at))).toMatchObject({ email: "capped" });
    expect(m.mails).toHaveLength(ADMIN_EMAIL_DAILY_CAP);
    // 15:00Z es 11:00 en Caracas: al día siguiente, otra vez hay cupo.
    const tomorrow = new Date(NOW.getTime() + 24 * 3_600_000);
    await clear();
    await report(new Date(tomorrow.getTime() - MIN));
    expect(await runMail(m.mailer, tomorrow)).toMatchObject({ email: "sent" });
  });

  it("correo: si Resend falla, no se repite y el error no lleva datos", async () => {
    await runMail(fakeMailer().mailer, NOW);
    await report(new Date(NOW.getTime() + MIN));
    expect(
      await runMail(fakeMailer({ fail: true }).mailer, new Date(NOW.getTime() + 2 * MIN)),
    ).toMatchObject({
      email: "failed",
      newPayments: 1,
    });
    const m = fakeMailer();
    expect(await runMail(m.mailer, new Date(NOW.getTime() + 3 * MIN))).toEqual({ status: "none" });
    expect(m.mails).toHaveLength(0);
  });

  it("correo: ningún dato del cliente (nombre, teléfono, referencia)", async () => {
    const m = fakeMailer();
    await runMail(m.mailer, NOW);
    await report(new Date(NOW.getTime() + MIN));
    await runMail(m.mailer, new Date(NOW.getTime() + 2 * MIN));
    const all = JSON.stringify(m.mails);
    expect(all).not.toContain("Bodega");
    expect(all).not.toContain("REF-SECRETA");
    expect(all).not.toMatch(/58\d{9,}/);
  });

  it("ResendMailer: manda texto plano a un solo destinatario y el error solo dice el código", async () => {
    const calls: { url: string; auth: string | null; body: unknown }[] = [];
    let status = 200;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ message: "rechazado: admin@example.com" }), { status });
    }) as typeof fetch;
    const mailer = new ResendMailer({
      apiKey: "re_test",
      from: "Rocco <avisos@example.com>",
      to: "admin@example.com",
      fetchImpl,
    });
    await mailer.send({ subject: "Rocco: pago por verificar", text: "hola" });
    expect(calls[0]).toEqual({
      url: "https://api.resend.com/emails",
      auth: "Bearer re_test",
      body: {
        from: "Rocco <avisos@example.com>",
        to: ["admin@example.com"],
        subject: "Rocco: pago por verificar",
        text: "hola",
      },
    });
    status = 422;
    const err = await mailer.send({ subject: "s", text: "t" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminEmailError);
    expect(String((err as Error).message)).toBe("el correo al administrador no salió (HTTP 422)");
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
