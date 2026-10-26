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
  parkSignup,
  parseAccounts,
  parseBudgets,
  parseBusinessType,
  parseCategoryList,
  parseKind,
  parsePersonName,
  remainingSteps,
  type SignupData,
  type SignupStep,
} from "../src/onboarding/chat-signup";
import { onboardingCategories } from "../src/onboarding/register";
import * as es from "../src/render/es-VE";
import type { Outbound } from "../src/render/outbound";
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
  });
  it("nombre: «buenos días», «quiero probar» y las palabras de sí o saltar no son nombres", () => {
    for (const t of [
      "Buenos días",
      "buenas noches!",
      "Buenas tardes.",
      "quiero probar",
      "Cómo funciona?",
      "info",
      "Información",
      "Hola Rocco",
      "Rocco",
      ...YES_WORDS,
      ...SKIP_WORDS,
    ])
      expect(parsePersonName(t), t).toBeNull();
    expect(parsePersonName("Sofía")).toBe("Sofía");
    expect(parsePersonName("Me llamo Dalia")).toBe("Dalia");
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

/** Las palabras de SÍ y SALTAR del handoff (F2a), escritas como las manda la gente. */
const YES_WORDS = [
  "sí",
  "Si",
  "sip",
  "Ok",
  "okey",
  "dale",
  "Listo",
  "perfecto",
  "correcto",
  "está bien",
  "Así está bien.",
  "me sirve",
  "me sirven",
  "sirven",
  "esas",
  "Usar estas",
  "¡Dale!",
];
const SKIP_WORDS = [
  "saltar",
  "Saltar.",
  "no",
  "No!",
  "nop",
  "ninguno",
  "ninguna",
  "ningún",
  "no tengo",
  "después",
  "luego",
  "Ahora no",
  "paso",
  "omitir",
  "no gracias",
];

describe("pasos que faltan (N del mensaje de regreso)", () => {
  const personal: SignupData = { kind: "personal" };
  const business: SignupData = { kind: "business" };
  it("personal: currency 3, categories 2, budget 1", () => {
    expect(remainingSteps("currency", personal)).toBe(3);
    expect(remainingSteps("categories", personal)).toBe(2);
    expect(remainingSteps("budget", personal)).toBe(1);
  });
  it("negocio: biz_name 5, biz_type 4, currency 3, categories 2, budget 1", () => {
    expect(remainingSteps("biz_name", business)).toBe(5);
    expect(remainingSteps("biz_type", business)).toBe(4);
    expect(remainingSteps("currency", business)).toBe(3);
    expect(remainingSteps("categories", business)).toBe(2);
    expect(remainingSteps("budget", business)).toBe(1);
  });
});

/** Textos nuevos del registro (auditoría del 26/10), letra por letra para cumplimiento. */
describe("textos del registro", () => {
  const URL = "https://holarocco.test";
  it("presentación", () => {
    expect(es.signupIntro(URL, null)).toEqual({
      type: "text",
      body: [
        "¡Epa! Soy *Rocco* 🐾, tu pana con las finanzas. Soy un asistente automático.",
        "Me escribes lo que gastas, en bolívares o en dólares, y lo anoto con la tasa BCV de ese día.",
        "",
        "Armamos tu cuenta aquí mismo en 2 minutos y tienes *14 días o 100 mensajes gratis* para probarme, lo que llegue primero.",
        "_Al seguir aceptas la política de privacidad: https://holarocco.test/privacidad_",
        "",
        "Son unas preguntas cortas. La primera: ¿cómo te llamas?",
      ].join("\n"),
    });
  });
  it("progreso delante de cada pregunta", () => {
    expect(es.signupAskBusinessName({ n: 3, total: 6 }).body).toBe(
      "*3 de 6* · ¡Buenísimo! ¿Cómo se llama tu negocio?",
    );
    expect(es.signupAskBusinessType("Arepas Doña Rosa", { n: 4, total: 6 }).body).toBe(
      "*4 de 6* · ¿A qué se dedica *Arepas Doña Rosa*? Así te sugiero las categorías de gastos que más se usan.",
    );
    expect(es.signupAskCurrency(false, { n: 3, total: 4 }).body).toBe(
      "*3 de 4* · ¿En qué moneda manejas más tu plata? Cuando no me digas la moneda, uso esta. Igual te muestro todo en las dos.",
    );
    expect(es.signupAskCategories(["Mercado", "Otros"], true, { n: 6, total: 6 }).body).toBe(
      [
        "*6 de 6* · Ahora tus *categorías de gastos*: así sabrás en qué se va la plata del negocio. Te sugiero estas:",
        "• Mercado",
        "• Otros",
        "",
        "¿Te sirven? Si prefieres otras, escríbemelas separadas por coma. Para sumar a estas: _agrega Gimnasio, Mascotas_",
      ].join("\n"),
    );
    expect(es.signupAskBusinessName().body).toBe("¡Buenísimo! ¿Cómo se llama tu negocio?");
  });
  it("categorías listas, presupuesto y solo texto", () => {
    expect(es.signupCategoriesSet(["Mercado", "Otros"]).body).toBe(
      "✅ Listo, tus categorías: Mercado, Otros.",
    );
    const tail = [
      "Ponle un *tope mensual en dólares* a una o varias categorías y te aviso cuánto te queda cada vez que anotes un gasto.",
      "Ejemplo: _Mercado 200, Transporte 80_",
      "Si no quieres ponerlo ahora, toca *Ahora no* y tu cuenta queda lista.",
    ];
    const cats = ["Mercado", "Transporte", "Otros"];
    expect(es.signupAskBudget(cats, false).body).toBe(
      ["Último paso, y es opcional: ¿en qué se te va más la plata?", ...tail].join("\n"),
    );
    expect(es.signupAskBudget(cats, true).body).toBe(
      ["Último paso, y es opcional: ¿en qué se va más la plata del negocio?", ...tail].join("\n"),
    );
    expect(es.signupTextOnly().body).toBe(
      "Para crear tu cuenta respóndeme con texto o con los botones. Cuando terminemos ya me puedes mandar notas de voz y fotos.",
    );
  });
  it("mensaje de regreso: con y sin nombre, N = 1 en singular", () => {
    expect(es.signupWelcomeBack("Ana", 2).body).toBe(
      [
        "¡Epa, Ana! Qué bueno que volviste. Seguimos armando tu cuenta donde quedamos: te faltan 2 pasos para que puedas anotar tus gastos.",
        "Si prefieres empezar de cero, escribe *empezar de nuevo*.",
      ].join("\n"),
    );
    expect(es.signupWelcomeBack(null, 1).body).toBe(
      [
        "¡Epa! Qué bueno que volviste. Seguimos armando tu cuenta donde quedamos: te falta 1 paso para que puedas anotar tus gastos.",
        "Si prefieres empezar de cero, escribe *empezar de nuevo*.",
      ].join("\n"),
    );
  });
  it("tour: «Cuentas (opcional)» sin cuentas; la línea de antes con cuentas", () => {
    const sin = es.signupTour(URL, "personal").body;
    expect(sin).toContain(
      "\n• *Cuentas (opcional):* _crea la cuenta Banesco en bolívares con 5.000_, _mis cuentas_\n",
    );
    expect(sin).not.toContain("• *Cuentas:*");
    expect(es.signupTour(URL, "business", true).body).toContain(
      "\n• *Cuentas:* _mis cuentas_, _pasé 100$ de Zelle a Binance_\n",
    );
  });
  it("cuerpo <= 1024, títulos de botón <= 20 y de fila <= 24, aun con datos largos", () => {
    const longName = "Inversiones y Distribuidora La Nueva Esperanza del Centro CA".slice(0, 60);
    const cats = Array.from({ length: 10 }, (_, i) => `Categoría larguísima número ${i + 1}`);
    const p = { n: 6, total: 6 };
    const all: Outbound[] = [
      es.signupIntro(URL, "Javier"),
      es.signupIntro(URL, null),
      es.signupAskName("Javier"),
      es.signupNameUnclear("Javier"),
      es.signupAskKind("María Alejandra de los Ángeles"),
      es.signupAskBusinessName(p),
      es.signupAskBusinessType(longName, p),
      es.signupAskCurrency(true, p),
      es.signupAskCategories(cats, true, p),
      es.signupCategoriesWrite(),
      es.signupCategoriesSet(cats),
      es.signupAskBudget(cats, true),
      es.signupBudgetUnclear(cats),
      es.signupTour(URL, "business"),
      es.signupTour(URL, "business", true),
      es.signupTextOnly(),
      es.signupWelcomeBack("María Alejandra de los Ángeles", 5),
      es.signupWelcomeBack(null, 1),
      es.signupHelp(),
    ];
    for (const o of all) {
      expect(o.body.length, o.body.slice(0, 40)).toBeLessThanOrEqual(1024);
      if (o.type === "buttons")
        for (const b of o.buttons) expect(b.title.length).toBeLessThanOrEqual(20);
      if (o.type === "list")
        for (const r of o.sections.flatMap((x) => x.rows))
          expect(r.title.length).toBeLessThanOrEqual(24);
    }
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
  const sentTo = (to: string) => meta.sent.filter((s) => s.to === to).length;

  /** Deja un número parado en un paso, con la última respuesta hace `hoursAgo` horas. */
  let parked = 0;
  async function park(step: SignupStep, data: SignupData, hoursAgo = 0) {
    const e164 = `5841455${String(6000 + ++parked)}`;
    const at = new Date(clock.getTime() - hoursAgo * 3_600_000);
    await t.db
      .insert(schema.signup)
      .values({ e164, step, data, messages: 4, createdAt: at, updatedAt: at });
    return e164;
  }
  const rowOf = async (e164: string) =>
    (await t.db.select().from(schema.signup).where(eq(schema.signup.e164, e164)))[0];
  const PERSONAL: SignupData = {
    name: "Luis",
    kind: "personal",
    businessType: "personal",
    currency: "USD",
  };
  const BUSINESS: SignupData = {
    name: "Rosa",
    kind: "business",
    businessName: "Arepas Rosa",
    businessType: "food",
    currency: "USD",
  };
  const withCats = (d: SignupData): SignupData => ({
    ...d,
    categories: onboardingCategories(undefined, d.businessType ?? "personal"),
  });

  it("un número nuevo recibe la presentación de Rocco y el botón con su nombre de perfil", async () => {
    expect(await say(NEW_NUMBER, "hola")).toBe("done");
    const intro = lastFor(NEW_NUMBER);
    expect(textOf(intro)).toContain("Soy *Rocco* 🐾");
    expect(textOf(intro)).toContain(
      "Armamos tu cuenta aquí mismo en 2 minutos y tienes *14 días o 100 mensajes gratis* para probarme, lo que llegue primero.",
    );
    expect(textOf(intro)).toContain("https://holarocco.test/privacidad");
    expect(idsOf(intro)).toEqual(["signup:name:profile"]);
  });

  it("negocio completo: nombre, tipo, moneda, categorías y presupuesto, sin cuentas", async () => {
    await tap(NEW_NUMBER, "signup:name:profile", "Llámame Javier");
    expect(textOf(lastFor(NEW_NUMBER))).toContain("Mucho gusto, Javier");
    await tap(NEW_NUMBER, "signup:kind:business", "Para mi negocio");
    expect(textOf(lastFor(NEW_NUMBER))).toBe("*3 de 6* · ¡Buenísimo! ¿Cómo se llama tu negocio?");
    await say(NEW_NUMBER, "Arepera La Esquina");
    expect(idsOf(lastFor(NEW_NUMBER))).toContain("signup:type:food");
    expect(textOf(lastFor(NEW_NUMBER))).toMatch(/^\*4 de 6\* · ¿A qué se dedica/);
    await tap(NEW_NUMBER, "signup:type:food", "Comida y bebidas", true);
    expect(idsOf(lastFor(NEW_NUMBER))).toEqual(["signup:cur:USD", "signup:cur:VES"]);
    expect(textOf(lastFor(NEW_NUMBER))).toMatch(/^\*5 de 6\* · ¿En qué moneda/);
    await tap(NEW_NUMBER, "signup:cur:USD", "Dólares");
    const cats = lastFor(NEW_NUMBER);
    expect(textOf(cats)).toContain("• Ingredientes");
    expect(textOf(cats)).toMatch(/^\*6 de 6\* · Ahora tus \*categorías de gastos\*/);
    await say(NEW_NUMBER, "agrega Harina, Queso");
    expect(textOf(lastFor(NEW_NUMBER, 2))).toMatch(/^✅ Listo, tus categorías: Harina, Queso.*\.$/);
    expect(textOf(lastFor(NEW_NUMBER))).toBe(
      [
        "Último paso, y es opcional: ¿en qué se va más la plata del negocio?",
        "Ponle un *tope mensual en dólares* a una o varias categorías y te aviso cuánto te queda cada vez que anotes un gasto.",
        "Ejemplo: _Harina 200, Queso 80_",
        "Si no quieres ponerlo ahora, toca *Ahora no* y tu cuenta queda lista.",
      ].join("\n"),
    );
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
      expect(accounts).toEqual([]);
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

  it("personal: sin cuentas y salta el presupuesto; audio y 'empezar de nuevo' en el camino", async () => {
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
    expect(textOf(lastFor(PERSONAL_NUMBER))).toMatch(/^\*3 de 4\* · ¿En qué moneda/);
    await say(PERSONAL_NUMBER, "en bolívares");
    expect(textOf(lastFor(PERSONAL_NUMBER))).toMatch(/^\*4 de 4\* · /);
    await tap(PERSONAL_NUMBER, "signup:cat:ok", "Usar estas");
    expect(textOf(lastFor(PERSONAL_NUMBER))).toMatch(
      /^Último paso, y es opcional: ¿en qué se te va más la plata\?/,
    );
    await tap(PERSONAL_NUMBER, "signup:bud:skip", "Ahora no");
    expect(textOf(lastFor(PERSONAL_NUMBER, 2))).toContain(
      "¡Listo, Ana María! Tu cuenta quedó creada.",
    );
    expect(textOf(lastFor(PERSONAL_NUMBER))).not.toContain("*Ventas:*");
    expect(textOf(lastFor(PERSONAL_NUMBER))).toContain(
      "• *Cuentas (opcional):* _crea la cuenta Banesco en bolívares con 5.000_, _mis cuentas_",
    );
    expect(
      meta.sent
        .filter((m) => m.to === PERSONAL_NUMBER)
        .map(textOf)
        .join("\n"),
    ).not.toMatch(/tus \*cuentas\*/);
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
  it('fila vieja en cuentas: «hola» → regreso (1 paso) y presupuesto, sin cuenta "Hola"', async () => {
    const n = await park("accounts", withCats(PERSONAL), 1);
    await say(n, "hola");
    expect(textOf(lastFor(n, 2))).toBe(
      [
        "¡Epa, Luis! Qué bueno que volviste. Seguimos armando tu cuenta donde quedamos: te falta 1 paso para que puedas anotar tus gastos.",
        "Si prefieres empezar de cero, escribe *empezar de nuevo*.",
      ].join("\n"),
    );
    expect(textOf(lastFor(n))).toMatch(/^Último paso, y es opcional/);
    expect(await rowOf(n)).toMatchObject({ step: "budget", data: { accounts: [] } });
    await tap(n, "signup:bud:skip", "Ahora no");
    expect(textOf(lastFor(n, 2))).toContain("¡Listo, Luis!");
    expect(textOf(lastFor(n, 2))).not.toContain("Cuentas:");
    const row = await rowOf(n);
    const accounts = await withTenant(t.db, row?.tenantId as string, (tx) =>
      tx.select({ name: schema.account.name }).from(schema.account),
    );
    expect(accounts.map((a) => a.name)).not.toContain("Hola");
  });

  it("fila vieja en confirmar cuentas: «sí» → regreso y presupuesto, sin cuentas pendientes", async () => {
    const n = await park("accounts_confirm", {
      ...withCats(BUSINESS),
      pendingAccounts: [{ name: "Hola", currency: "USD", kind: "other", openingBalance: "0.00" }],
    });
    await say(n, "sí");
    expect(textOf(lastFor(n, 2))).toContain("¡Epa, Rosa! Qué bueno que volviste.");
    expect(textOf(lastFor(n, 2))).toContain("te falta 1 paso");
    expect(textOf(lastFor(n))).toMatch(
      /^Último paso, y es opcional: ¿en qué se va más la plata del negocio\?/,
    );
    const row = await rowOf(n);
    expect(row?.step).toBe("budget");
    expect((row?.data as SignupData | undefined)?.accounts).toEqual([]);
    expect((row?.data as SignupData | undefined)?.pendingAccounts).toBeUndefined();
  });

  it("fila vieja en cuentas: los botones siguen igual", async () => {
    const n = await park("accounts_confirm", {
      ...withCats(BUSINESS),
      pendingAccounts: [
        { name: "Banesco", currency: "VES", kind: "bank", openingBalance: "5000.00" },
      ],
    });
    const before = sentTo(n);
    await tap(n, "signup:acc:ok", "Así está bien");
    expect(sentTo(n) - before).toBe(1);
    expect(textOf(lastFor(n))).toMatch(/^Último paso/);
    expect((await rowOf(n))?.data).toMatchObject({ accounts: [{ name: "Banesco" }] });
  });

  it("vuelve a las 25 h en categorías con «hola»: regreso (2 pasos) y la pregunta, sin tocarlas", async () => {
    const n = await park("categories", PERSONAL, 25);
    await say(n, "hola");
    expect(textOf(lastFor(n, 2))).toContain("te faltan 2 pasos para que puedas anotar tus gastos.");
    expect(textOf(lastFor(n))).toMatch(/^\*4 de 4\* · Ahora tus \*categorías de gastos\*/);
    const row = await rowOf(n);
    expect(row?.step).toBe("categories");
    expect((row?.data as SignupData | undefined)?.categories).toBeUndefined();
    // Ya no está «lejos»: la siguiente respuesta se lee normal.
    await say(n, "sí");
    expect((await rowOf(n))?.step).toBe("budget");
  });

  it("a las 2 h, «hola» en categorías repite la pregunta sin tocarlas", async () => {
    const n = await park("categories", PERSONAL, 2);
    const before = sentTo(n);
    await say(n, "hola");
    expect(sentTo(n) - before).toBe(1);
    expect(textOf(lastFor(n))).toMatch(/^\*4 de 4\* · Ahora tus \*categorías de gastos\*/);
    const row = await rowOf(n);
    expect(row?.step).toBe("categories");
    expect((row?.data as SignupData | undefined)?.categories).toBeUndefined();
  });

  it("un botón válido del paso se procesa normal aunque pasen días", async () => {
    const n = await park("categories", PERSONAL, 72);
    const before = sentTo(n);
    await tap(n, "signup:cat:ok", "Usar estas");
    expect(sentTo(n) - before).toBe(2);
    expect(textOf(lastFor(n, 2))).toMatch(/^✅ Listo, tus categorías: /);
    expect((await rowOf(n))?.step).toBe("budget");
  });

  it("N correcto en el regreso, en cada paso, personal y negocio", async () => {
    const cases: [SignupStep, SignupData, string, RegExp][] = [
      ["currency", PERSONAL, "te faltan 3 pasos", /^\*3 de 4\* · ¿En qué moneda/],
      ["categories", PERSONAL, "te faltan 2 pasos", /^\*4 de 4\* · /],
      ["budget", withCats(PERSONAL), "te falta 1 paso", /^Último paso/],
      ["biz_name", BUSINESS, "te faltan 5 pasos", /^\*3 de 6\* · ¡Buenísimo!/],
      ["biz_type", BUSINESS, "te faltan 4 pasos", /^\*4 de 6\* · ¿A qué se dedica \*Arepas Rosa\*/],
      ["currency", BUSINESS, "te faltan 3 pasos", /^\*5 de 6\* · ¿En qué moneda/],
      ["categories", BUSINESS, "te faltan 2 pasos", /^\*6 de 6\* · /],
      ["budget", withCats(BUSINESS), "te falta 1 paso", /^Último paso/],
    ];
    for (const [step, data, n, question] of cases) {
      const e164 = await park(step, data, 7);
      await say(e164, "hola");
      expect(textOf(lastFor(e164, 2)), `${data.kind} ${step}`).toContain(
        `Seguimos armando tu cuenta donde quedamos: ${n} para que puedas anotar tus gastos.`,
      );
      expect(textOf(lastFor(e164)), `${data.kind} ${step}`).toMatch(question);
      expect((await rowOf(e164))?.step).toBe(step);
    }
  });

  it("en nombre y en personal/negocio no hay mensaje de regreso (no se sabe N)", async () => {
    const atName = await park("name", {}, 30);
    await say(atName, "hola");
    expect(textOf(lastFor(atName))).toContain("No te entendí el nombre");
    expect(textOf(lastFor(atName))).not.toContain("volviste");
    const atKind = await park("kind", { name: "Luis" }, 30);
    await say(atKind, "hola");
    expect(textOf(lastFor(atKind))).toMatch(/^¡Mucho gusto, Luis!/);
    expect(
      meta.sent
        .filter((m) => m.to === atKind)
        .map(textOf)
        .join(),
    ).not.toContain("volviste");
  });

  it("cada palabra de SÍ en categorías usa las sugeridas; en presupuesto no guarda nada", async () => {
    const suggested = onboardingCategories(undefined, "personal");
    for (const word of YES_WORDS) {
      const n = await park("categories", PERSONAL);
      await say(n, word);
      const row = await rowOf(n);
      expect(row?.step, word).toBe("budget");
      expect((row?.data as SignupData | undefined)?.categories, word).toEqual(suggested);
      const b = await park("budget", withCats(PERSONAL));
      await say(b, word);
      const brow = await rowOf(b);
      expect(brow?.step, word).toBe("budget");
      expect((brow?.data as SignupData | undefined)?.budgets, word).toBeUndefined();
    }
  });

  it("cada palabra de SALTAR en presupuesto termina el registro; en categorías no se guarda", async () => {
    for (const word of SKIP_WORDS) {
      const c = await park("categories", PERSONAL);
      await say(c, word);
      const crow = await rowOf(c);
      expect(crow?.step, word).toBe("categories");
      expect((crow?.data as SignupData | undefined)?.categories, word).toBeUndefined();
      const n = await park("budget", withCats(BUSINESS));
      await say(n, word);
      const row = await rowOf(n);
      expect(row?.step, word).toBe("done");
      expect((row?.data as SignupData | undefined)?.budgets, word).toEqual([]);
      expect(textOf(lastFor(n, 2)), word).toContain("*Arepas Rosa* ya está conmigo.");
    }
  });

  it("ninguna palabra de intención queda como categoría o nombre", async () => {
    const bad = /^(hola|si|sí|ok|saltar|no)$/i;
    for (const word of ["hola", "Hola", ...YES_WORDS, ...SKIP_WORDS]) {
      const c = await park("categories", BUSINESS);
      await say(c, word);
      const cats = ((await rowOf(c))?.data as SignupData | undefined)?.categories ?? [];
      expect(
        cats.filter((x) => bad.test(x)),
        word,
      ).toEqual([]);
      const nm = await park("name", {});
      await say(nm, word);
      const row = await rowOf(nm);
      expect(row?.step, word).toBe("name");
      expect((row?.data as SignupData | undefined)?.name, word).toBeUndefined();
    }
  });

  it("«Empezar de nuevo.» reinicia desde cualquier paso", async () => {
    for (const word of ["Empezar de nuevo.", "empezar de nuevo!", "Empezar de nuevo"]) {
      const n = await park("categories", PERSONAL, 30);
      await say(n, word);
      expect(textOf(lastFor(n)), word).toBe("¿Cómo te llamas?");
      expect(await rowOf(n)).toMatchObject({ step: "name", data: {} });
    }
  });
  describe("prueba del «hola» con un número de prueba (parkSignup)", () => {
    const TEST_NUMBER = "+58 414-555-7777";
    const E164 = "584145557777";
    const accountsOf = async (tenantId: string) =>
      (
        await withTenant(t.db, tenantId, (tx) =>
          tx.select({ name: schema.account.name }).from(schema.account),
        )
      ).map((a) => a.name);

    it('un solo número: categorías primero, después cuentas, y al final se registra sin cuenta "Hola"', async () => {
      // 1) Parado en categorías desde hace 7 h: «hola» → regreso (2 pasos) + la pregunta.
      const parked = await parkSignup(t.db, { e164: TEST_NUMBER, step: "categories" }, clock);
      expect(parked.e164).toBe(E164);
      let before = sentTo(E164);
      await say(E164, "hola");
      expect(sentTo(E164) - before).toBe(2);
      expect(textOf(lastFor(E164, 2))).toBe(
        [
          "¡Epa, Prueba! Qué bueno que volviste. Seguimos armando tu cuenta donde quedamos: te faltan 2 pasos para que puedas anotar tus gastos.",
          "Si prefieres empezar de cero, escribe *empezar de nuevo*.",
        ].join("\n"),
      );
      expect(textOf(lastFor(E164))).toMatch(/^\*4 de 4\* · Ahora tus \*categorías de gastos\*/);
      let row = await rowOf(E164);
      expect(row?.step).toBe("categories");
      expect(row?.data).toEqual(parked.data);

      // 2) El mismo número, ahora parado en cuentas como lo dejaba el flujo viejo.
      const old = await parkSignup(t.db, { e164: E164, step: "accounts" }, clock);
      expect(old.data.categories?.length).toBeGreaterThan(0);
      before = sentTo(E164);
      await say(E164, "hola");
      expect(sentTo(E164) - before).toBe(2);
      expect(textOf(lastFor(E164, 2))).toContain("¡Epa, Prueba! Qué bueno que volviste.");
      expect(textOf(lastFor(E164, 2))).toContain(
        "te falta 1 paso para que puedas anotar tus gastos.",
      );
      expect(textOf(lastFor(E164))).toMatch(
        /^Último paso, y es opcional: ¿en qué se te va más la plata\?/,
      );
      row = await rowOf(E164);
      expect(row?.step).toBe("budget");
      expect(row?.data).toMatchObject({ categories: old.data.categories, accounts: [] });

      // 3) Termina: el negocio no tiene la cuenta "Hola".
      await tap(E164, "signup:bud:skip", "Ahora no");
      row = await rowOf(E164);
      expect(row?.step).toBe("done");
      expect(await accountsOf(row?.tenantId as string)).not.toContain("Hola");
      expect(textOf(lastFor(E164))).toContain("• *Cuentas (opcional):*");
    });

    it("no toca un número que ya tiene negocio", async () => {
      await expect(parkSignup(t.db, { e164: E164, step: "categories" }, clock)).rejects.toThrow(
        /ya tiene un negocio/,
      );
      await expect(parkSignup(t.db, { e164: "123", step: "accounts" }, clock)).rejects.toThrow(
        /número inválido/,
      );
    });

    it("negocio parado en cuentas: «hola» → regreso y presupuesto del negocio", async () => {
      const n = "584145557778";
      await parkSignup(t.db, { e164: n, step: "accounts", kind: "business" }, clock);
      await say(n, "hola");
      expect(textOf(lastFor(n, 2))).toContain("te falta 1 paso");
      expect(textOf(lastFor(n))).toMatch(
        /^Último paso, y es opcional: ¿en qué se va más la plata del negocio\?/,
      );
      expect((await rowOf(n))?.data).toMatchObject({ accounts: [] });
    });

    it("sin mover updated_at (0 h), «hola» en categorías solo repite la pregunta", async () => {
      const n = "584145557779";
      await parkSignup(t.db, { e164: n, step: "categories", hoursAgo: 0 }, clock);
      const before = sentTo(n);
      await say(n, "hola");
      expect(sentTo(n) - before).toBe(1);
      expect(textOf(lastFor(n))).toMatch(/^\*4 de 4\* · /);
      expect((await rowOf(n))?.step).toBe("categories");
    });
  });
});
