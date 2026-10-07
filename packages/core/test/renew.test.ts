import { and, eq, schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient, LlmResponse } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import { saveLaunchSettings } from "../src/billing/launch";
import { approvePayment, rejectPayment } from "../src/billing/payments";
import { extractReference } from "../src/billing/renew";
import { Decimal } from "../src/domain/money";
import { ingestWebhook } from "../src/inbox/ingest";
import { sendPaymentNotices } from "../src/inbox/notices";
import { type ProcessDeps, processInbound } from "../src/inbox/process";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/** Renovar el plan por el bot (03/10): oferta, método, referencia, plan vencido y avisos. */

describe("referencia de un pago", () => {
  it("con palabra clave siempre; sin intención abierta, nada más", () => {
    expect(extractReference("ref 123456", false)).toBe("123456");
    expect(extractReference("Referencia: 0001234", false)).toBe("0001234");
    expect(extractReference("número de confirmación JPM99ABC12", false)).toBe("JPM99ABC12");
    expect(extractReference("ya pagué 98765432", false)).toBeNull();
    expect(extractReference("12345678", false)).toBeNull();
  });
  it("con intención abierta: 'ya pagué <número>' y el número solo; un gasto no", () => {
    expect(extractReference("ya pagué, 98765432", true)).toBe("98765432");
    expect(extractReference("  12345678 ", true)).toBe("12345678");
    expect(extractReference("pagué 19468 bs de luz", true)).toBeNull();
    expect(extractReference("gasté 1500 en harina", true)).toBeNull();
    expect(extractReference("hola", true)).toBeNull();
  });
});

describe("renovar el plan por WhatsApp", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  let clock = new Date("2026-10-03T15:00:00Z");
  const now = () => clock;
  const jobs: ProcessMessageJob[] = [];
  let seq = 0;
  const OWNER = "584121234567";
  const EMPLOYEE = "584140000002";
  const ADMIN = { userId: "11111111-1111-4111-8111-111111111111", email: "admin@x.com" };

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Autolavado",
      businessType: "car_wash",
      ownerPhone: OWNER,
    });
    await withTenant(t.db, tenantId, async (tx) => {
      await tx.insert(schema.phoneNumber).values({
        tenantId,
        e164: EMPLOYEE,
        role: "employee",
        status: "active",
        displayName: "Carlos",
        verifiedAt: now(),
      });
      await tx
        .update(schema.tenant)
        .set({ plan: "negocio", trialEndsAt: new Date("2026-10-13T15:00:00Z") })
        .where(eq(schema.tenant.id, tenantId));
    });
    await t.db.insert(schema.bcvRate).values({
      effectiveDate: "2026-10-02",
      rate: "866.56000000",
      rateEur: "973.93000000",
      source: "test",
    });
  });
  afterAll(() => t.close());

  const renew = (id: string, input: Record<string, unknown> = {}) => [
    {
      id,
      name: "renew_plan",
      input: { plan: "current", months: 1, method: "unknown", reference: "", ...input },
    },
  ];
  const llmCalls: string[] = [];
  const llm: LlmClient = {
    model: "claude-sonnet-5-5",
    async complete(req) {
      const last = req.turns[req.turns.length - 1];
      const text = last && "text" in last ? (last.text ?? "") : "";
      const msg = text.split("Mensaje del usuario: ")[1] ?? "";
      llmCalls.push(msg);
      const script: Record<string, LlmResponse["toolCalls"]> = {
        "quiero renovar": renew("r1"),
        "pásame a negocio plus 3 meses": renew("r2", { plan: "negocio_plus", months: 3 }),
        "ya pagué el plan por zelle, confirmación ZX12345": renew("r3", {
          method: "zelle",
          reference: "ZX12345",
        }),
        "gasté 1500 en harina": [
          {
            id: "g1",
            name: "draft_expense",
            input: {
              amount: "1500",
              currency: "VES",
              description: "Harina",
              category_name: "",
              when: "",
              rate: "",
              corrects_draft: false,
            },
          },
        ],
      };
      const key = Object.keys(script).find((k) => msg.includes(k));
      if (!key) throw new Error(`sin guion para: ${msg}`);
      return {
        toolCalls: script[key] ?? [],
        text: null,
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: "claude-sonnet-5-5",
      };
    },
    costUsd: () => new Decimal(0),
  };

  type Sent = { to: string; body: Record<string, unknown> };
  type Interactive = {
    body: { text: string };
    action: { buttons: { reply: { id: string; title: string } }[] };
  };
  const textOf = (s: Sent | undefined) =>
    String(
      (s?.body.text as { body?: string } | undefined)?.body ??
        (s?.body.interactive as Interactive | undefined)?.body.text ??
        "",
    );
  const buttonsOf = (s: Sent | undefined) =>
    (s?.body.interactive as Interactive | undefined)?.action.buttons.map((b) => b.reply) ?? [];

  function fakeMeta() {
    const sent: Sent[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (body.status !== "read") sent.push({ to: String(body.to ?? ""), body });
      return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT.${Math.random()}` }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return {
      sent,
      client: new MetaClient({ accessToken: "T", phoneNumberId: fx.PHONE_NUMBER_ID, fetchImpl }),
    };
  }
  function deps(client: MetaClient): ProcessDeps {
    return {
      db: t.db,
      metaFor: () => client,
      agent: createAgent({ llm, now }),
      now,
      config: {
        assistantName: "x",
        dashboardUrl: "https://caja.test",
        supportHint: "WhatsApp +58 424 0000000",
        unknownReplyMax: 50,
        unknownReplyWindowMs: 3_600_000,
        maxEventAgeMs: 12 * 3_600_000,
        maxTextLength: 500,
        knownMax: 1000,
        paymentDest: {
          pago_movil: "Banco de Venezuela · 0412 0000000 · C.I. 1.234.567",
          zelle: "pagos@x.com · Javier",
          binance: "pagos@x.com",
        },
      },
    };
  }
  const ingest = async (payload: unknown) => {
    jobs.length = 0;
    await ingestWebhook(
      { db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) },
      payload,
    );
    return jobs[0] as ProcessMessageJob;
  };
  async function send(client: MetaClient, body: string, from = OWNER) {
    const p = JSON.parse(JSON.stringify(fx.textMessage(`wamid.R${++seq}`, body)));
    p.entry[0].changes[0].value.messages[0].from = from;
    p.entry[0].changes[0].value.contacts[0].wa_id = from;
    const job = await ingest(p);
    return job ? processInbound(deps(client), job) : "no-job";
  }
  async function tap(client: MetaClient, id: string, title: string, from = OWNER) {
    const p = JSON.parse(JSON.stringify(fx.buttonReply));
    const m = p.entry[0].changes[0].value.messages[0];
    m.id = `wamid.RB${++seq}`;
    m.from = from;
    m.interactive.button_reply = { id, title };
    return processInbound(deps(client), await ingest(p));
  }
  const payments = () =>
    withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.payment).orderBy(schema.payment.createdAt),
    );

  it("beta: en la prueba no hay precios; solo los días y los mensajes que quedan", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "quiero renovar");
    expect(textOf(sent[0])).toMatch(
      /^\*Tu prueba gratis\* · beta de Rocco\nTe quedan \*10 días\* \(hasta el mar 13\/10\) y \*\d+ de 200 mensajes\*\.\nDurante la prueba no pagas nada\./,
    );
    expect(buttonsOf(sent[0])).toEqual([]);
    // Un botón viejo de pago tampoco abre el cobro.
    await tap(client, "renew:zelle:negocio:1", "Zelle");
    expect(textOf(sent[1])).toContain("*Tu prueba gratis* · beta de Rocco");
    expect(await payments()).toEqual([]);
    // De aquí en adelante, modo live: los precios se muestran siempre.
    await saveLaunchSettings(t.db, { beta: false, surveyDay: 10, valueDay: 12 }, "test", clock);
  });

  it("plan activo: oferta con montos y un botón por método; el método guarda la intención", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "quiero renovar");
    expect(textOf(sent[0])).toBe(
      "*Tu plan: Negocio*\nTu prueba gratis termina el mar 13/10 (faltan 10 días).\nLlevas *3 de 200 mensajes* de tu prueba.\nRenovar 1 mes:\n• Pago móvil: *Bs 19.468,86* (tasa euro 973,93)\n• Zelle: *$19,99*\n• Binance: *19,99 USDT*\n¿Cómo vas a pagar?",
    );
    expect(buttonsOf(sent[0])).toEqual([
      { id: "renew:pago_movil:negocio:1", title: "Pago móvil" },
      { id: "renew:zelle:negocio:1", title: "Zelle" },
      { id: "renew:binance:negocio:1", title: "Binance" },
    ]);
    await tap(client, "renew:pago_movil:negocio:1", "Pago móvil");
    expect(textOf(sent[1])).toBe(
      "*Pago móvil* · Plan Negocio, 1 mes\nMonto: *Bs 19.468,86* (tasa euro 973,93)\nDatos: Banco de Venezuela · 0412 0000000 · C.I. 1.234.567\nCuando pagues, mándame la referencia. Ejemplo: _ref 123456_",
    );
  });

  it("con la intención abierta, un gasto sigue siendo gasto y 'ref 123456' reporta sin LLM", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "gasté 1500 en harina");
    expect(textOf(sent[0])).toContain("Gasto por confirmar");
    llmCalls.length = 0;
    await send(client, "ref 123456");
    expect(llmCalls).toEqual([]);
    expect(textOf(sent[1])).toBe(
      "✅ Recibí tu pago: Plan Negocio, 1 mes, *Bs 19.468,86* (tasa euro 973,93), ref 123456. Lo verificamos y te aviso por aquí.",
    );
    const [p] = await payments();
    expect(p).toMatchObject({
      status: "pending",
      plan: "negocio",
      months: 1,
      method: "pago_movil",
      currency: "VES",
      amount: "19468.86",
      amountUsd: "19.99",
      rateKind: "bcv_eur",
      reference: "123456",
      notes: "Reportado por WhatsApp",
    });
    const [audit] = await withTenant(t.db, tenantId, (tx) =>
      tx
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.entity, "payment"), eq(schema.auditLog.action, "report"))),
    );
    expect(audit).toMatchObject({ actorType: "phone", channel: "whatsapp" });
  });

  it("cambiar de plan y meses; reportar con método y referencia en un solo mensaje", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "pásame a negocio plus 3 meses");
    expect(textOf(sent[0])).toContain("*Cambiar a Negocio Plus* (hoy tienes Negocio)");
    expect(textOf(sent[0])).toContain("Renovar 3 meses:");
    expect(textOf(sent[0])).toContain("• Zelle: *$119,97*");
    expect(buttonsOf(sent[0])[1]?.id).toBe("renew:zelle:negocio_plus:3");
    await send(client, "ya pagué el plan por zelle, confirmación ZX12345");
    expect(textOf(sent[1])).toBe(
      "✅ Recibí tu pago: Plan Negocio, 1 mes, *$19,99*, ref ZX12345. Lo verificamos y te aviso por aquí.",
    );
  });

  it("el empleado no renueva", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "quiero renovar", EMPLOYEE);
    expect(textOf(sent[0])).toBe("El plan lo renueva el dueño del negocio.");
    await tap(client, "renew:zelle:negocio:1", "Zelle", EMPLOYEE);
    expect(textOf(sent[1])).toBe("El plan lo renueva el dueño del negocio.");
  });

  it("plan vencido: el dueño renueva sin LLM; lo demás responde 'tu plan venció'", async () => {
    await withTenant(t.db, tenantId, async (tx) => {
      await tx
        .update(schema.tenant)
        .set({ status: "suspended", paidUntil: new Date("2026-09-20T15:00:00Z") })
        .where(eq(schema.tenant.id, tenantId));
      // Los pagos de los casos anteriores no cuentan para este (tope de 3 pendientes).
      await tx.delete(schema.payment);
    });
    const { sent, client } = fakeMeta();
    llmCalls.length = 0;
    await send(client, "hola, gasté 10$ en champú");
    expect(textOf(sent[0])).toBe(
      "Tu plan venció y por ahora no puedo registrar nada. Tus datos siguen guardados. Para renovarlo escribe *renovar* y te digo cómo pagar. Si necesitas ayuda: WhatsApp +58 424 0000000",
    );
    await send(client, "renovar");
    expect(textOf(sent[1])).toContain("*Tu plan: Negocio*");
    expect(textOf(sent[1])).toContain("¿Cómo vas a pagar?");
    await tap(client, "renew:zelle:negocio:1", "Zelle");
    expect(textOf(sent[2])).toContain("Datos: pagos@x.com · Javier");
    await send(client, "ya pagué, 98765432");
    expect(textOf(sent[3])).toContain(
      "✅ Recibí tu pago: Plan Negocio, 1 mes, *$19,99*, ref 98765432",
    );
    // Referencia sin método elegido: un botón por método la reporta de una vez.
    await send(client, "ref 55555");
    expect(textOf(sent[4])).toBe("Recibí la referencia 55555. ¿Por dónde pagaste?");
    expect(buttonsOf(sent[4]).map((b) => b.id)).toEqual([
      "renewref:pago_movil:55555",
      "renewref:zelle:55555",
      "renewref:binance:55555",
    ]);
    await tap(client, "renewref:binance:55555", "Binance");
    expect(textOf(sent[5])).toContain("*19,99 USDT*, ref 55555");
    expect(llmCalls).toEqual([]);
    // Tope de 3 pagos por verificar.
    await send(client, "ref 77777");
    await tap(client, "renewref:zelle:77777", "Zelle");
    expect(textOf(sent.at(-1))).toContain("ref 77777");
    await send(client, "ref 88888");
    await tap(client, "renewref:zelle:88888", "Zelle");
    expect(textOf(sent.at(-1))).toContain("Ya tienes 3 pagos por verificar");
  });

  it("al aprobar o rechazar, el dueño recibe el aviso una sola vez si escribió en 24 h", async () => {
    const { sent, client } = fakeMeta();
    const pays = (await payments()).filter((p) => p.status === "pending");
    await withTenant(t.db, tenantId, async (tx) => {
      await approvePayment(tx, tenantId, pays[0]?.id as string, ADMIN, now());
      await rejectPayment(tx, tenantId, pays[1]?.id as string, ADMIN, "no llegó el pago", now());
    });
    const first = await sendPaymentNotices(t.db, client, { now: now(), supportHint: "WA" });
    expect(first).toEqual({ sent: 2, skipped: 0 });
    const bodies = sent.map(textOf);
    expect(
      bodies.some((b) =>
        /^✅ Pago verificado\. Tu plan Negocio quedó activo hasta el .+\. ¡Gracias por la confianza!$/.test(
          b,
        ),
      ),
    ).toBe(true);
    expect(bodies).toContain(
      "No pudimos verificar tu pago con referencia 55555. Motivo: no llegó el pago. Revisa los datos y vuelve a mandarme la referencia. Si crees que es un error, escríbenos: WA",
    );
    expect(sent.every((s) => s.to === OWNER)).toBe(true);
    expect(await sendPaymentNotices(t.db, client, { now: now(), supportHint: "WA" })).toEqual({
      sent: 0,
      skipped: 0,
    });
    // Dos días después sin mensajes del dueño: se marca, pero no se manda (Meta exige plantilla).
    // Los mensajes guardan la hora real de la base: el salto parte de la más tardía de las dos
    // (antes partía del reloj fijo y la prueba empezó a fallar al llegar esa fecha de verdad).
    clock = new Date(Math.max(clock.getTime(), Date.now()) + 2 * 24 * 3_600_000);
    const left = (await payments()).filter((p) => p.status === "pending");
    await withTenant(t.db, tenantId, (tx) =>
      approvePayment(tx, tenantId, left[0]?.id as string, ADMIN, now()),
    );
    expect(await sendPaymentNotices(t.db, client, { now: now(), supportHint: "WA" })).toEqual({
      sent: 0,
      skipped: 1,
    });
  });
});
