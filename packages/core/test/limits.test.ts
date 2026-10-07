import { eq, schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import { addExtraMessages, approvePayment } from "../src/billing/payments";
import { founderUntilFrom } from "../src/billing/plans";
import { withDiscount } from "../src/billing/pricing";
import { renewOfferReply } from "../src/billing/renew-chat";
import { caracasMonth } from "../src/billing/usage";
import { businessDateOf } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";
import { ingestWebhook } from "../src/inbox/ingest";
import { type ProcessDeps, processInbound } from "../src/inbox/process";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/** Límite duro del plan, recargas y precio fundador (0019). */
describe("precio fundador", () => {
  it("7 meses desde el registro y 40 % redondeado al centavo", () => {
    expect(founderUntilFrom("2026-10-07")).toBe("2027-05-07");
    expect(withDiscount(new Decimal("5.99"), 40).toFixed(2)).toBe("3.59");
    expect(withDiscount(new Decimal("19.99"), 40).toFixed(2)).toBe("11.99");
    expect(withDiscount(new Decimal("19.99"), 0).toFixed(2)).toBe("19.99");
  });
});

describe("límite del mes y recargas por WhatsApp", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  let phoneId: string;
  // Reloj real: el aviso de "una vez al día" compara con created_at, que pone la base.
  const clock = new Date();
  const month = caracasMonth(clock).key;
  const paidUntil = new Date(clock.getTime() + 20 * 86_400_000);
  const now = () => clock;
  const jobs: ProcessMessageJob[] = [];
  let seq = 0;
  const OWNER = "584121234567";
  const ADMIN = { userId: "11111111-1111-4111-8111-111111111111", email: "admin@x.com" };
  let agentCalls = 0;

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Ana",
      businessType: "personal",
      ownerPhone: OWNER,
    });
    await withTenant(t.db, tenantId, async (tx) => {
      await tx
        .update(schema.tenant)
        .set({
          plan: "personal",
          status: "active",
          paidUntil,
          founderUntil: "2027-05-07",
        })
        .where(eq(schema.tenant.id, tenantId));
      const [p] = await tx.select().from(schema.phoneNumber);
      phoneId = p?.id ?? "";
    });
    await t.db.insert(schema.bcvRate).values({
      effectiveDate: businessDateOf(clock),
      rate: "200.00000000",
      rateEur: "230.00000000",
      source: "test",
    });
  });
  afterAll(() => t.close());

  const llm: LlmClient = {
    model: "fake",
    async complete() {
      agentCalls += 1;
      return {
        toolCalls: [
          { id: "x", name: "ask_clarification", input: { question: "¿Cuánto fue?", options: [] } },
        ],
        text: null,
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: "fake",
      };
    },
    costUsd: () => new Decimal(0),
  };

  type Sent = { to: string; body: Record<string, unknown> };
  type Interactive = {
    body: { text: string };
    action: { buttons: { reply: { id: string; title: string } }[] };
  };
  const sent: Sent[] = [];
  const textOf = (s: Sent | undefined) =>
    String(
      (s?.body.text as { body?: string } | undefined)?.body ??
        (s?.body.interactive as Interactive | undefined)?.body.text ??
        "",
    );
  const buttonsOf = (s: Sent | undefined) =>
    (s?.body.interactive as Interactive | undefined)?.action.buttons.map((b) => b.reply.id) ?? [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (body.status !== "read") sent.push({ to: String(body.to ?? ""), body });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT.${Math.random()}` }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const client = new MetaClient({ accessToken: "T", phoneNumberId: fx.PHONE_NUMBER_ID, fetchImpl });

  const deps = (): ProcessDeps => ({
    db: t.db,
    metaFor: () => client,
    agent: createAgent({ llm, now }),
    now,
    config: {
      assistantName: "Rocco",
      dashboardUrl: "https://holarocco.test",
      supportHint: null,
      unknownReplyMax: 50,
      unknownReplyWindowMs: 3_600_000,
      maxEventAgeMs: 12 * 3_600_000,
      maxTextLength: 500,
      knownMax: 1000,
      captionWaitMs: 0,
      paymentDest: { zelle: "pagos@x.com · Javier", binance: "pagos@x.com" },
    },
  });
  async function deliver(payload: Record<string, unknown>) {
    jobs.length = 0;
    await ingestWebhook(
      { db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) },
      payload,
    );
    return processInbound(deps(), jobs[0] as ProcessMessageJob);
  }
  const send = (body: string) => {
    const p = JSON.parse(JSON.stringify(fx.textMessage(`wamid.L${++seq}`, body)));
    p.entry[0].changes[0].value.messages[0].from = OWNER;
    p.entry[0].changes[0].value.contacts[0].wa_id = OWNER;
    return deliver(p);
  };
  const tap = (id: string, title: string) => {
    const p = JSON.parse(JSON.stringify(fx.buttonReply));
    const m = p.entry[0].changes[0].value.messages[0];
    m.id = `wamid.LB${++seq}`;
    m.from = OWNER;
    m.interactive.button_reply = { id, title };
    return deliver(p);
  };
  /** Mensajes entrantes de este mes, como si ya los hubiera mandado. */
  const used = (n: number) =>
    withTenant(t.db, tenantId, (tx) =>
      tx.insert(schema.message).values(
        Array.from({ length: n }, () => ({
          tenantId,
          phoneId,
          direction: "in",
          kind: "text",
          body: "x",
          createdAt: new Date(
            Math.max(caracasMonth(clock).start.getTime(), clock.getTime() - 60_000),
          ),
        })),
      ),
    );

  it("al pasar el 80 % avisa una sola vez, después de la respuesta", async () => {
    await used(95); // con el siguiente van 96 de 120
    await send("gasté algo");
    expect(textOf(sent.at(-2))).toBe("¿Cuánto fue?");
    expect(textOf(sent.at(-1))).toContain("vas por *96 de 120 mensajes*");
    const before = sent.length;
    await send("gasté otra cosa");
    expect(sent.length).toBe(before + 1);
    expect(textOf(sent.at(-1))).toBe("¿Cuánto fue?");
  });

  it("pasado el tope no llama a la IA: avisa una vez al día y ofrece recargar", async () => {
    await used(23); // 97 + 23 = 120; el próximo es el 121
    const calls = agentCalls;
    await send("gasté 5$ en café");
    expect(agentCalls).toBe(calls);
    expect(textOf(sent.at(-1))).toContain("Llegaste a los *120 mensajes* de tu plan Personal");
    expect(textOf(sent.at(-1))).toContain("*recargar* (+20 por $1 o +100 por $4)");
    const before = sent.length;
    await send("y otro gasto");
    expect(sent.slice(before)).toEqual([]);
  });

  it("'recargar' → elige recarga; montos por método; método → datos; referencia → pago pendiente", async () => {
    await send("recargar");
    const offer = sent.at(-1);
    expect(textOf(offer)).toContain("• +20 mensajes por $1");
    expect(textOf(offer)).toContain("• +100 mensajes por $4");
    expect(buttonsOf(offer)).toEqual(["recharge:s", "recharge:m"]);
    await tap("recharge:m", "+100 por $4");
    const methods = sent.at(-1);
    expect(textOf(methods)).toContain("*Recarga: +100 mensajes por $4*");
    expect(textOf(methods)).toContain("• Zelle: *$4,00*");
    expect(buttonsOf(methods)).toEqual(["renew:zelle:recharge-m:1", "renew:binance:recharge-m:1"]);
    await tap("renew:zelle:recharge-m:1", "Zelle");
    expect(textOf(sent.at(-1))).toContain("*Zelle* · Recarga de 100 mensajes");
    await send("ref 778899");
    expect(textOf(sent.at(-1))).toContain("Recibí tu pago: recarga de 100 mensajes");
    const [pay] = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.payment));
    expect(pay).toMatchObject({
      kind: "recharge",
      plan: "personal",
      amountUsd: "4.00",
      extraMessages: 100,
      status: "pending",
      reference: "778899",
    });
  });

  it("la recarga chica: +20 por $1", async () => {
    await tap("recharge:s", "+20 por $1");
    expect(textOf(sent.at(-1))).toContain("*Recarga: +20 mensajes por $1*");
    expect(textOf(sent.at(-1))).toContain("• Zelle: *$1,00*");
    await tap("renew:zelle:recharge-s:1", "Zelle");
    expect(textOf(sent.at(-1))).toContain("*Zelle* · Recarga de 20 mensajes");
  });

  it("aprobada la recarga: +100 este mes, sin tocar la vigencia; Rocco vuelve a responder", async () => {
    const [pay] = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.payment));
    await withTenant(t.db, tenantId, (tx) =>
      approvePayment(tx, tenantId, pay?.id ?? "", ADMIN, clock),
    );
    const [tn] = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId)),
    );
    expect(tn).toMatchObject({ extraMessages: 100, extraMonth: month, status: "active" });
    expect(tn?.paidUntil?.toISOString()).toBe(paidUntil.toISOString());
    await send("gasté algo más");
    expect(textOf(sent.at(-1))).toBe("¿Cuánto fue?");
  });

  it("prueba por mensajes: aviso al 80 % y el 101 ya no llama a la IA", async () => {
    await t.db.delete(schema.message);
    await withTenant(t.db, tenantId, (tx) =>
      tx
        .update(schema.tenant)
        .set({
          status: "trial",
          createdAt: new Date(clock.getTime() - 86_400_000),
          capWarnedMonth: null,
          extraMessages: 0,
        })
        .where(eq(schema.tenant.id, tenantId)),
    );
    await used(79); // con el siguiente van 80 de 100
    await send("gasté algo");
    expect(textOf(sent.at(-2))).toBe("¿Cuánto fue?");
    expect(textOf(sent.at(-1))).toContain("te quedan *20 de 100 mensajes*");
    await used(19); // 99; el siguiente es el 100, todavía incluido
    await send("otro gasto");
    expect(textOf(sent.at(-1))).toBe("¿Cuánto fue?");
    const calls = agentCalls;
    await send("y uno más");
    expect(agentCalls).toBe(calls);
    expect(textOf(sent.at(-1))).toContain("Usaste los *100 mensajes* de tu prueba gratis");
    // El administrador le regala +100: el tope de la prueba sube y Rocco vuelve a responder.
    await withTenant(t.db, tenantId, async (tx) => {
      const [tn] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId));
      if (tn)
        await addExtraMessages(tx, { ...tn, extraMessages: 0 }, 100, ADMIN, clock, "admin_gift");
    });
    await send("gasté en pan");
    expect(agentCalls).toBe(calls + 1);
    expect(textOf(sent.at(-1))).toBe("¿Cuánto fue?");
  });

  it("renovar con precio fundador: 40 % menos y la línea que lo explica", async () => {
    await withTenant(t.db, tenantId, (tx) =>
      tx.update(schema.tenant).set({ status: "active" }).where(eq(schema.tenant.id, tenantId)),
    );
    const out = await withTenant(t.db, tenantId, (tx) =>
      renewOfferReply(tx, {
        tenantId,
        phoneId,
        now: clock,
        dest: { zelle: "pagos@x.com" },
        supportHint: null,
      }),
    );
    const offer = out.body;
    expect(offer).toContain("Precio de fundador: 40 % menos hasta el");
    expect(offer).toContain("• Zelle: *$3,59*");
  });
});
