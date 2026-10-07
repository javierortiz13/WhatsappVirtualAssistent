import { randomUUID } from "node:crypto";
import { and, eq, schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import { Decimal } from "../src/domain/money";
import { ingestWebhook } from "../src/inbox/ingest";
import { type ProcessDeps, processInbound } from "../src/inbox/process";
import {
  cleanProfileName,
  createDashboardLink,
  parseAccounts,
  parseBudgets,
  parseBusinessType,
  parseCategoryList,
  parseKind,
  parsePersonName,
} from "../src/onboarding/chat-signup";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/** Registro por WhatsApp (0018): lectores de respuestas y el flujo de punta a punta. */
describe("lectores del registro por chat", () => {
  it("nombre: quita 'me llamo', rechaza saludos y números", () => {
    expect(parsePersonName("Me llamo javier ortiz")).toBe("Javier Ortiz");
    expect(parsePersonName("soy María.")).toBe("María");
    expect(parsePersonName("hola")).toBeNull();
    expect(parsePersonName("Buenas tardes")).toBeNull();
    expect(parsePersonName("gasté 15$")).toBeNull();
    expect(cleanProfileName("javier ortiz")).toBe("Javier");
    expect(cleanProfileName("🔥🔥")).toBeNull();
  });
  it("para mí o para mi negocio; tipo de negocio por palabras", () => {
    expect(parseKind("para mí")).toBe("personal");
    expect(parseKind("es para mi negocio")).toBe("business");
    expect(parseKind("qué?")).toBeNull();
    expect(parseBusinessType("una arepera")).toBe("food");
    expect(parseBusinessType("bodega")).toBe("retail");
    expect(parseBusinessType("taller mecánico")).toBe("services");
    expect(parseBusinessType("algo raro")).toBe("other");
  });
  it("cuentas: nombre, monto, moneda y tipo; sin moneda la deduce", () => {
    expect(parseAccounts("Banesco 5.000 bs\nBinance 120 usdt\nefectivo 40$", "USD")).toEqual([
      { name: "Banesco", currency: "VES", kind: "bank", openingBalance: "5000.00" },
      { name: "Binance", currency: "USD", kind: "crypto", openingBalance: "120.00" },
      { name: "Efectivo", currency: "USD", kind: "cash", openingBalance: "40.00" },
    ]);
    expect(parseAccounts("Mercantil 12.500,50, Zelle 300", "USD")).toEqual([
      { name: "Mercantil", currency: "VES", kind: "bank", openingBalance: "12500.50" },
      { name: "Zelle", currency: "USD", kind: "zelle", openingBalance: "300.00" },
    ]);
    expect(parseAccounts("tengo 50 usdt", "VES")).toEqual([
      { name: "Binance", currency: "USD", kind: "crypto", openingBalance: "50.00" },
    ]);
    expect(parseAccounts("no sé", "USD")).toEqual([
      { name: "No sé", currency: "USD", kind: "other", openingBalance: "0.00" },
    ]);
  });
  it("categorías: lista propia o 'agrega' a las sugeridas, siempre con Otros", () => {
    expect(parseCategoryList("Mercado, gasolina, Gimnasio", "personal")).toEqual([
      "Mercado",
      "Gasolina",
      "Gimnasio",
      "Otros",
    ]);
    const added = parseCategoryList("agrega Mascotas", "personal") ?? [];
    expect(added[0]).toBe("Mascotas");
    expect(added).toContain("Mercado");
    expect(added.at(-1)).toBe("Otros");
    expect(added.length).toBeLessThanOrEqual(10);
  });
  it("presupuestos: categoría existente y monto en dólares", () => {
    const cats = ["Mercado", "Comida fuera", "Transporte", "Otros"];
    expect(parseBudgets("Mercado 200, comida 80$ al mes", cats)).toEqual([
      { category: "Mercado", amountUsd: "200.00" },
      { category: "Comida fuera", amountUsd: "80.00" },
    ]);
    expect(parseBudgets("Mercado 20.000 bs", cats)).toEqual([]);
    expect(parseBudgets("Viajes 100", cats)).toEqual([]);
  });
});

type Sent = { to: string; body: Record<string, unknown> };
const NEW_NUMBER = "584145550101";
const PERSONAL_NUMBER = "584145550202";

function fakeMeta() {
  const sent: Sent[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (body.status !== "read") sent.push({ to: String(body.to), body });
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

const textOf = (s: Sent | undefined) =>
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

describe("registro por WhatsApp de punta a punta", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  const clock = new Date("2026-10-07T14:00:00Z");
  const now = () => clock;
  const jobs: ProcessMessageJob[] = [];
  let seq = 0;
  const meta = fakeMeta();

  beforeAll(async () => {
    t = await createTestDb();
    await t.db
      .insert(schema.bcvRate)
      .values({ effectiveDate: "2026-10-07", rate: "200.00000000", source: "test" });
  });
  afterAll(() => t.close());

  const deps = (): ProcessDeps => ({
    db: t.db,
    metaFor: () => meta.client,
    agent: createAgent({ llm, now }),
    now,
    config: {
      assistantName: "Rocco",
      dashboardUrl: "https://holarocco.test",
      supportHint: null,
      unknownReplyMax: 5,
      unknownReplyWindowMs: 3_600_000,
      maxEventAgeMs: 12 * 3_600_000,
      maxTextLength: 500,
      captionWaitMs: 0,
    },
  });

  async function deliver(from: string, payload: Record<string, unknown>) {
    jobs.length = 0;
    const p = payload as {
      entry: {
        changes: { value: { contacts: unknown[]; messages: Record<string, unknown>[] } }[];
      }[];
    };
    const value = p.entry[0]?.changes[0]?.value;
    if (value) {
      value.contacts[0] = { profile: { name: "Javier Ortiz" }, wa_id: from };
      const m = value.messages[0];
      if (m) {
        m.from = from;
        m.id = `wamid.SU${++seq}`;
      }
    }
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    return processInbound(deps(), jobs[0] as ProcessMessageJob);
  }
  const say = (from: string, body: string) =>
    deliver(from, structuredClone(fx.textMessage("x", body)) as unknown as Record<string, unknown>);
  async function tap(from: string, id: string, title = "x", list = false) {
    const p = structuredClone(list ? fx.listReply : fx.buttonReply) as unknown as {
      entry: { changes: { value: { messages: { interactive: Record<string, unknown> }[] } }[] }[];
    };
    const m = p.entry[0]?.changes[0]?.value.messages[0];
    if (m) {
      if (list) m.interactive.list_reply = { id, title };
      else {
        m.interactive.button_reply = { id, title };
        delete (m as Record<string, unknown>).context;
      }
    }
    return deliver(from, p as unknown as Record<string, unknown>);
  }
  const lastFor = (to: string, back = 1) => meta.sent.filter((s) => s.to === to).at(-back);

  it("un número nuevo recibe la presentación de Rocco y el botón con su nombre de perfil", async () => {
    expect(await say(NEW_NUMBER, "hola")).toBe("done");
    const intro = lastFor(NEW_NUMBER);
    expect(textOf(intro)).toContain("Soy *Rocco* 🐾");
    expect(textOf(intro)).toContain("14 días gratis");
    expect(textOf(intro)).toContain("https://holarocco.test/privacidad");
    expect(idsOf(intro)).toEqual(["signup:name:profile"]);
  });

  it("negocio completo: nombre, tipo, moneda, categorías, cuentas y presupuesto", async () => {
    await tap(NEW_NUMBER, "signup:name:profile", "Llámame Javier");
    expect(textOf(lastFor(NEW_NUMBER))).toContain("Mucho gusto, Javier");
    await tap(NEW_NUMBER, "signup:kind:business", "Para mi negocio");
    expect(textOf(lastFor(NEW_NUMBER))).toContain("¿Cómo se llama tu negocio?");
    await say(NEW_NUMBER, "Arepera La Esquina");
    expect(idsOf(lastFor(NEW_NUMBER))).toContain("signup:type:food");
    await tap(NEW_NUMBER, "signup:type:food", "Comida y bebidas", true);
    expect(idsOf(lastFor(NEW_NUMBER))).toEqual(["signup:cur:USD", "signup:cur:VES"]);
    await tap(NEW_NUMBER, "signup:cur:USD", "Dólares");
    const cats = lastFor(NEW_NUMBER);
    expect(textOf(cats)).toContain("• Ingredientes");
    await say(NEW_NUMBER, "agrega Harina, Queso");
    expect(textOf(lastFor(NEW_NUMBER, 2))).toContain("✅ Listo, tus categorías: Harina, Queso");
    expect(textOf(lastFor(NEW_NUMBER))).toContain("tus *cuentas*");
    await say(NEW_NUMBER, "Banesco 5.000 bs\nefectivo 40$");
    const confirm = lastFor(NEW_NUMBER);
    expect(textOf(confirm)).toContain("• Banesco: *Bs 5.000,00*");
    expect(textOf(confirm)).toContain("• Efectivo: *$40,00*");
    await tap(NEW_NUMBER, "signup:acc:ok", "Así está bien");
    expect(textOf(lastFor(NEW_NUMBER))).toContain("tope mensual en dólares");
    await say(NEW_NUMBER, "Ingredientes 300");
    const done = lastFor(NEW_NUMBER, 2);
    expect(textOf(done)).toContain("¡Listo, Javier! *Arepera La Esquina* ya está conmigo.");
    expect(textOf(done)).toContain("Presupuesto: Ingredientes $300,00 al mes");
    const tour = lastFor(NEW_NUMBER);
    expect(textOf(tour)).toContain("*Ventas:*");
    expect(textOf(tour)).toContain("https://holarocco.test/login");

    const [phone] = await t.db
      .select()
      .from(schema.phoneNumber)
      .where(eq(schema.phoneNumber.e164, NEW_NUMBER));
    expect(phone?.status).toBe("active");
    expect(phone?.role).toBe("owner");
    expect(phone?.verifiedAt).not.toBeNull();
    const tenantId = phone?.tenantId as string;
    await withTenant(t.db, tenantId, async (tx) => {
      const [tenant] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId));
      expect(tenant).toMatchObject({
        name: "Arepera La Esquina",
        businessType: "food",
        plan: "negocio",
        status: "trial",
        signupChannel: "whatsapp",
        defaultExpenseCurrency: "USD",
      });
      const catRows = await tx
        .select({ name: schema.category.name })
        .from(schema.category)
        .where(eq(schema.category.tenantId, tenantId));
      expect(catRows.map((c) => c.name)).toEqual(
        expect.arrayContaining(["Harina", "Queso", "Ingredientes", "Otros"]),
      );
      const accounts = await tx
        .select({ name: schema.account.name, currency: schema.account.currency })
        .from(schema.account)
        .where(eq(schema.account.tenantId, tenantId));
      expect(accounts).toEqual(
        expect.arrayContaining([
          { name: "Banesco", currency: "VES" },
          { name: "Efectivo", currency: "USD" },
        ]),
      );
      const budgets = await tx
        .select({ amountUsd: schema.budget.amountUsd, period: schema.budget.period })
        .from(schema.budget)
        .where(eq(schema.budget.tenantId, tenantId));
      expect(budgets).toEqual([{ amountUsd: "300.00", period: "monthly" }]);
    });
    const [signup] = await t.db
      .select()
      .from(schema.signup)
      .where(eq(schema.signup.e164, NEW_NUMBER));
    expect(signup?.step).toBe("done");
    expect(signup?.tenantId).toBe(tenantId);
  });

  it("ya registrado: el siguiente mensaje va al agente como cualquier dueño", async () => {
    await say(NEW_NUMBER, "gasté algo");
    expect(textOf(lastFor(NEW_NUMBER))).toBe("¿Cuánto fue?");
  });

  it("conectar el dashboard: código de la web mandado por WhatsApp → dueño en el panel", async () => {
    const userId = randomUUID();
    await t.db.insert(schema.userAccount).values({ id: userId, email: "javier@ejemplo.com" });
    await say(NEW_NUMBER, "link del dashboard");
    expect(textOf(lastFor(NEW_NUMBER))).toContain("*Ya me registré con Rocco*");
    const { code } = await createDashboardLink(t.db, userId, clock);
    await say(NEW_NUMBER, code);
    expect(textOf(lastFor(NEW_NUMBER))).toBe(
      "✅ Listo, tu dashboard quedó conectado a *javier@ejemplo.com*. Ya puedes ver, corregir y exportar todo desde la web.",
    );
    const [phone] = await t.db
      .select({ tenantId: schema.phoneNumber.tenantId })
      .from(schema.phoneNumber)
      .where(eq(schema.phoneNumber.e164, NEW_NUMBER));
    const members = await withTenant(t.db, phone?.tenantId as string, (tx) =>
      tx
        .select({ role: schema.tenantMember.role })
        .from(schema.tenantMember)
        .where(
          and(
            eq(schema.tenantMember.tenantId, phone?.tenantId as string),
            eq(schema.tenantMember.userId, userId),
          ),
        ),
    );
    expect(members).toEqual([{ role: "owner" }]);
    // El mismo código no sirve dos veces: el segundo va al agente como un mensaje más.
    await say(NEW_NUMBER, code);
    expect(textOf(lastFor(NEW_NUMBER))).toBe("¿Cuánto fue?");
  });

  it("personal: salta cuentas y presupuesto; audio y 'empezar de nuevo' en el camino", async () => {
    await say(PERSONAL_NUMBER, "buenas");
    await say(PERSONAL_NUMBER, "hola");
    expect(textOf(lastFor(PERSONAL_NUMBER))).toContain("No te entendí el nombre");
    await say(PERSONAL_NUMBER, "Me llamo Ana");
    await deliver(
      PERSONAL_NUMBER,
      structuredClone(fx.audioMessage) as unknown as Record<string, unknown>,
    );
    expect(textOf(lastFor(PERSONAL_NUMBER, 2))).toContain("respóndeme con texto");
    expect(textOf(lastFor(PERSONAL_NUMBER))).toContain("Mucho gusto, Ana");
    await say(PERSONAL_NUMBER, "empezar de nuevo");
    expect(textOf(lastFor(PERSONAL_NUMBER))).toBe("¿Cómo te llamas?");
    await say(PERSONAL_NUMBER, "Ana María");
    await say(PERSONAL_NUMBER, "para mí");
    await say(PERSONAL_NUMBER, "en bolívares");
    await tap(PERSONAL_NUMBER, "signup:cat:ok", "Usar estas");
    await tap(PERSONAL_NUMBER, "signup:acc:skip", "Saltar");
    await tap(PERSONAL_NUMBER, "signup:bud:skip", "Ahora no");
    expect(textOf(lastFor(PERSONAL_NUMBER, 2))).toContain(
      "¡Listo, Ana María! Tu cuenta quedó creada.",
    );
    expect(textOf(lastFor(PERSONAL_NUMBER))).not.toContain("*Ventas:*");
    const [phone] = await t.db
      .select({ tenantId: schema.phoneNumber.tenantId })
      .from(schema.phoneNumber)
      .where(eq(schema.phoneNumber.e164, PERSONAL_NUMBER));
    const [tenant] = await withTenant(t.db, phone?.tenantId as string, (tx) =>
      tx
        .select()
        .from(schema.tenant)
        .where(eq(schema.tenant.id, phone?.tenantId as string)),
    );
    expect(tenant).toMatchObject({
      name: "Ana María",
      businessType: "personal",
      plan: "personal",
      defaultExpenseCurrency: "VES",
    });
  });
});
