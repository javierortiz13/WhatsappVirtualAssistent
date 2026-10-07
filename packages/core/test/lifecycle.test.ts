import { eq, schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import { saveLaunchSettings } from "../src/billing/launch";
import { Decimal } from "../src/domain/money";
import { ingestWebhook } from "../src/inbox/ingest";
import { sendLifecycleNotices } from "../src/inbox/lifecycle";
import { type ProcessDeps, processInbound } from "../src/inbox/process";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/** Prueba gratis (0019): encuesta de precio el día 10 y resumen de valor el día 12. */
describe("ciclo de la prueba gratis", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  let phoneId: string;
  const clock = new Date();
  const now = () => clock;
  const DAY = 86_400_000;
  const jobs: ProcessMessageJob[] = [];
  let seq = 0;
  const OWNER = "584121234567";

  type Sent = { to: string; body: Record<string, unknown> };
  const sent: Sent[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (body.status !== "read") sent.push({ to: String(body.to ?? ""), body });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT.${Math.random()}` }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const client = new MetaClient({ accessToken: "T", phoneNumberId: fx.PHONE_NUMBER_ID, fetchImpl });
  const bodyOf = (s: Sent | undefined) =>
    String(
      (s?.body.text as { body?: string } | undefined)?.body ??
        (s?.body.interactive as { body?: { text?: string } } | undefined)?.body?.text ??
        "",
    );
  const idsOf = (s: Sent | undefined): string[] => {
    const i = s?.body.interactive as
      | {
          action?: {
            buttons?: { reply: { id: string } }[];
            sections?: { rows: { id: string }[] }[];
          };
        }
      | undefined;
    return [
      ...(i?.action?.buttons?.map((b) => b.reply.id) ?? []),
      ...(i?.action?.sections?.flatMap((s) => s.rows.map((r) => r.id)) ?? []),
    ];
  };

  const llm: LlmClient = {
    model: "fake",
    async complete() {
      throw new Error("no debería llamar a la IA");
    },
    costUsd: () => new Decimal(0),
  };
  const deps = (): ProcessDeps => ({
    db: t.db,
    metaFor: () => client,
    agent: createAgent({ llm, now }),
    now,
    config: {
      assistantName: "Rocco",
      dashboardUrl: "https://holarocco.test",
      supportHint: "WhatsApp +58 424 0000000",
      unknownReplyMax: 50,
      unknownReplyWindowMs: 3_600_000,
      maxEventAgeMs: 12 * 3_600_000,
      maxTextLength: 500,
      knownMax: 1000,
      paymentDest: { zelle: "pagos@x.com" },
    },
  });
  async function say(body: string) {
    const p = JSON.parse(JSON.stringify(fx.textMessage(`wamid.LCT${++seq}`, body)));
    p.entry[0].changes[0].value.messages[0].from = OWNER;
    p.entry[0].changes[0].value.contacts[0].wa_id = OWNER;
    jobs.length = 0;
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    return processInbound(deps(), jobs[0] as ProcessMessageJob);
  }
  async function tap(id: string, list = true) {
    const p = JSON.parse(JSON.stringify(list ? fx.listReply : fx.buttonReply));
    const m = p.entry[0].changes[0].value.messages[0];
    m.id = `wamid.LC${++seq}`;
    m.from = OWNER;
    if (list) m.interactive.list_reply = { id, title: "x" };
    else m.interactive.button_reply = { id, title: "x" };
    jobs.length = 0;
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    return processInbound(deps(), jobs[0] as ProcessMessageJob);
  }
  const setTenant = (v: Partial<typeof schema.tenant.$inferInsert>) =>
    withTenant(t.db, tenantId, (tx) =>
      tx.update(schema.tenant).set(v).where(eq(schema.tenant.id, tenantId)),
    );
  const tenant = async () =>
    (
      await withTenant(t.db, tenantId, (tx) =>
        tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId)),
      )
    )[0];
  const wroteAgo = (ms: number) =>
    withTenant(t.db, tenantId, (tx) =>
      tx.insert(schema.message).values({
        tenantId,
        phoneId,
        direction: "in",
        kind: "text",
        body: "x",
        createdAt: new Date(clock.getTime() - ms),
      }),
    );

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, { name: "Ana", businessType: "food", ownerPhone: OWNER });
    const [p] = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.phoneNumber));
    phoneId = p?.id ?? "";
    await setTenant({
      status: "trial",
      createdAt: new Date(clock.getTime() - 9 * DAY),
      trialEndsAt: new Date(clock.getTime() + 5 * DAY),
      founderUntil: "2027-05-07",
    });
  });
  afterAll(() => t.close());

  it("antes del día 10 o fuera de la ventana de 24 h no manda nada", async () => {
    await wroteAgo(2 * DAY);
    expect(await sendLifecycleNotices(t.db, client, { now: clock })).toEqual({
      survey: 0,
      value: 0,
      trialEnd: 0,
      failed: 0,
    });
    await setTenant({ createdAt: new Date(clock.getTime() - 10 * DAY) });
    expect((await sendLifecycleNotices(t.db, client, { now: clock })).survey).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("día 10 con el dueño en la ventana: encuesta de precio con dos listas y las respuestas guardadas", async () => {
    await wroteAgo(60 * 60_000);
    expect((await sendLifecycleNotices(t.db, client, { now: clock })).survey).toBe(1);
    expect(bodyOf(sent.at(-1))).toContain("¿cuánto te parecería *justo* pagar al mes por mí?");
    expect(idsOf(sent.at(-1))).toContain("survey:fair:5-8");
    // Una sola vez.
    expect((await sendLifecycleNotices(t.db, client, { now: clock })).survey).toBe(0);
    await tap("survey:fair:5-8");
    expect(bodyOf(sent.at(-1))).toContain("te parecería *caro*");
    await tap("survey:expensive:12-20");
    expect(bodyOf(sent.at(-1))).toContain("¡Gracias! Con esto armamos los precios.");
    expect((await tenant())?.survey).toMatchObject({ fair: "5-8", expensive: "12-20" });
  });

  it("día 12: resumen de lo anotado con '¿seguimos?' y la respuesta en el CRM", async () => {
    await withTenant(t.db, tenantId, async (tx) => {
      const [rate] = await tx.select().from(schema.bcvRate).limit(1);
      const base = {
        tenantId,
        currency: "USD",
        rateId: rate?.id ?? null,
        rateValue: "200",
        rateSource: "manual",
        businessDate: "2026-10-05",
        sourceChannel: "text",
        createdByPhoneId: phoneId,
        createdAt: new Date(clock.getTime() - 3 * DAY),
      };
      await tx.insert(schema.movement).values([
        {
          ...base,
          type: "expense",
          amount: "40",
          amountUsd: "40",
          amountVes: "8000",
          paymentMethod: "cash_usd",
        },
        {
          ...base,
          type: "income",
          amount: "150",
          amountUsd: "150",
          amountVes: "30000",
          paymentMethod: "cash_usd",
        },
      ] as (typeof schema.movement.$inferInsert)[]);
    });
    await setTenant({ createdAt: new Date(clock.getTime() - 12 * DAY) });
    expect((await sendLifecycleNotices(t.db, client, { now: clock })).value).toBe(1);
    const body = bodyOf(sent.at(-1));
    expect(body).toContain(
      "anoté *2 movimientos* contigo: *$40,00* en gastos y *$150,00* en ventas",
    );
    expect(body).toContain("*precio de fundador*");
    expect(idsOf(sent.at(-1))).toEqual(["survey:continue:yes", "survey:continue:doubts"]);
    await tap("survey:continue:doubts", false);
    expect(bodyOf(sent.at(-1))).toContain("WhatsApp +58 424 0000000");
    expect((await tenant())?.survey).toMatchObject({ continue: "doubts" });
  });
  it("terminó la prueba: un aviso con los precios y los botones para pagar", async () => {
    await setTenant({ trialEndsAt: new Date(clock.getTime() - 60 * 60_000) });
    await wroteAgo(30 * 60_000);
    const opts = { now: clock, dest: { zelle: "pagos@x.com" }, supportHint: null };
    expect((await sendLifecycleNotices(t.db, client, opts)).trialEnd).toBe(1);
    const body = bodyOf(sent.at(-1));
    expect(body).toContain("Se terminó tu prueba gratis. ¡Gracias por probarme en la beta!");
    expect(body).toContain("*Tu plan: Negocio*\nTu prueba terminó el");
    expect(body).toContain("Precio de fundador: 40 % menos");
    expect(body).toContain("• Zelle: *$11,99*");
    expect(idsOf(sent.at(-1))).toEqual(["renew:zelle:negocio:1"]);
    // Una sola vez.
    expect((await sendLifecycleNotices(t.db, client, opts)).trialEnd).toBe(0);
  });

  it("los días de la encuesta y del resumen se cambian en /admin", async () => {
    await setTenant({
      createdAt: new Date(clock.getTime() - 7 * DAY),
      trialEndsAt: new Date(clock.getTime() + 7 * DAY),
      surveySentAt: null,
      valueSentAt: null,
    });
    expect((await sendLifecycleNotices(t.db, client, { now: clock })).survey).toBe(0);
    await saveLaunchSettings(t.db, { beta: true, surveyDay: 7, valueDay: 12 }, "test", clock);
    expect((await sendLifecycleNotices(t.db, client, { now: clock })).survey).toBe(1);
    expect(bodyOf(sent.at(-1))).toContain("Ya llevamos 7 días juntos");
  });
  it("suspendido sin haber pagado nunca: 'terminó tu prueba' con los precios, sin IA", async () => {
    await setTenant({ status: "suspended", suspendedAt: clock, paidUntil: null });
    await say("gasté 5$ en café");
    const body = bodyOf(sent.at(-1));
    expect(body).toContain("Tu prueba gratis terminó y por ahora no puedo registrar nada.");
    expect(body).toContain("• Zelle: *$11,99*");
    expect(idsOf(sent.at(-1))).toEqual(["renew:zelle:negocio:1"]);
  });
});
